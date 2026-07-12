// ============================================================
// lib/gemma.ts
//
// Generates NPC dialogue via Gemma (gemma-4-26b-a4b-it, through
// the same Gemini API used by lib/embeddings.ts), grounded in
// retrieved lore chunks and the current relationship stage.
//
// Affection is NOT scored per message — per README's daily flow,
// it's a single end-of-day batch evaluation over the full day's
// conversation, done in a separate (not yet built) module. This
// file only generates dialogue.
//
// NOTE: Gemma's support for Gemini-only features like
// responseSchema/systemInstruction is unconfirmed (undocumented
// as of this writing) — so this asks Gemma for JSON via plain
// prompt instructions and parses the text response manually,
// rather than relying on those fields. See lib/supabase.ts's
// header for the project's other schema/API drift notes.
// ============================================================

import { GoogleGenAI } from '@google/genai';
import type { MatchedChunk } from './supabase.js';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });

const MODEL = 'gemma-4-26b-a4b-it';

export type NPCCharacter = 'hiyori' | 'shiori' | 'yuki';

// Voice/tone only, deliberately fact-free — these are always included
// in every prompt, while concrete details already live in lore_chunks
// and get pulled in via retrieval. Restating facts here risks drifting
// out of sync with what's actually stored.
const PERSONAS: Record<NPCCharacter, string> = {
  hiyori: 'Warm on the surface, guarded underneath. Classic tsundere — genuine self-protection, not performance. Deflects compliments with sarcasm, downplays her own feelings even in her private diary. Notices everything, says little. Warms up slowly but completely once she trusts someone.',
  shiori: "Warm, direct, quietly perceptive. Research-minded even about social situations — analytical, sometimes reads as clinical but genuinely cares. Gives real advice, not validation. Protective of Hiyori — won't be friendly if Adrian hurts her. Won't help Adrian manipulate or play games.",
  yuki: "Composed, thoughtful, a little guarded. Feels things deeply but processes privately. Reads people emotionally rather than analytically. Dry, understated humor once comfortable. Has quiet, unspoken feelings for Adrian since secondary school that she's mostly talked herself out of pursuing. Loyal, dependable, shows up without being asked. Won't confess unless Adrian's own attention toward her makes it surface.",
};

export interface DialogueTurn {
  role: 'player' | 'npc';
  content: string;
}

// README lists 4 named relationship stages (Stranger -> Acquaintance
// -> Friend -> Close Friend) elsewhere but says "5 tiers" in the
// Hidden Affection Meter section — that's an unresolved inconsistency
// in the design doc, not something to guess at here. Left as a plain
// string until the tier system itself gets built and that's settled.
export type RelationshipStage = string;

export interface DialogueResult {
  reply: string;
}

// Build the full prompt string sent to Gemma for one turn.
function buildPrompt(
  character: NPCCharacter,
  playerMessage: string,
  chunks: MatchedChunk[],
  history: DialogueTurn[],
  relationshipStage: RelationshipStage
): string {
  const name = character[0].toUpperCase() + character.slice(1);

  const memoryText = chunks.length > 0
    ? chunks.map((chunk, i) => `${i + 1}. ${chunk.content}`).join('\n')
    : '(Nothing specific comes to mind.)';

  const historyText = history.length > 0
    ? history.map((turn) => `${turn.role === 'player' ? 'Player' : name}: ${turn.content}`).join('\n')
    : '(This is the start of the conversation.)';

  return `You are roleplaying as ${name} in a narrative dating simulation. Stay fully in character — respond the way ${name} would actually speak, not as an AI assistant.

PERSONALITY: ${PERSONAS[character]}

CURRENT RELATIONSHIP STAGE WITH THE PLAYER: ${relationshipStage}
Let this stage guide your warmth/guardedness — earlier stages should read more reserved, later stages more open. Never state the stage name or any numeric score out loud.

RELEVANT MEMORY (things ${name} knows, from the story so far):
${memoryText}

CONVERSATION SO FAR:
${historyText}

Player just said: "${playerMessage}"

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "reply": "<what ${name} says back, in her voice, 1-3 sentences>" }`;
}

// Parse Gemma's raw text response into a DialogueResult.
function parseDialogueResult(rawText: string): DialogueResult {
  // Gemma sometimes wraps JSON in ```json fences despite being told not to.
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemma response was not valid JSON: ${rawText}`);
  }

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { reply: unknown }).reply !== 'string') {
    throw new Error(`Gemma response did not match the expected shape: ${rawText}`);
  }

  return { reply: (parsed as { reply: string }).reply };
}

// Generate one NPC dialogue turn.
export async function generateDialogue(
  character: NPCCharacter,
  playerMessage: string,
  chunks: MatchedChunk[],
  history: DialogueTurn[],
  relationshipStage: RelationshipStage
): Promise<DialogueResult> {
  const prompt = buildPrompt(character, playerMessage, chunks, history, relationshipStage);

  // Single-turn contents: history is already flattened into the prompt
  // text by buildPrompt, and systemInstruction support is unconfirmed
  // for Gemma via this SDK (see header note).
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });

  if (!response.text) {
    throw new Error('Gemma returned no text');
  }

  return parseDialogueResult(response.text);
}
