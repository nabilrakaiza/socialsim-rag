// ============================================================
// lib/gemma.ts
//
// Generates NPC dialogue via Gemma (gemma-4-26b-a4b-it, through
// the same Gemini API used by lib/embeddings.ts), grounded in
// retrieved lore chunks and the current relationship stage.
//
// Affection is NOT scored per message — per README's daily flow,
// it's a single end-of-day batch evaluation over the full day's
// conversation. That's generateAffectionDelta/generateKnowledgeUpdate/
// generateDiaryEntry below — separate focused calls rather than one
// combined prompt, so a JSON-shape failure in one doesn't block the
// others and each prompt stays small enough to debug on its own.
// Diary trigger conditions themselves are NOT decided by Gemma — see
// lib/relationship.ts's checkDiaryTrigger for that deterministic logic.
//
// NOTE: Gemma's support for Gemini-only features like
// responseSchema/systemInstruction is unconfirmed (undocumented
// as of this writing) — so this asks Gemma for JSON via plain
// prompt instructions and parses the text response manually,
// rather than relying on those fields. See lib/supabase.ts's
// header for the project's other schema/API drift notes.
// ============================================================

import { GoogleGenAI } from '@google/genai';
import type { MatchedChunk } from './supabase';
import type { RelationshipStage } from './relationship';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });

// Model choice, measured rather than assumed. On a realistic dialogue prompt
// (persona + retrieved lore + history), averaged over 3 runs each:
//
//   gemini-3.6-flash       5.2s   — fastest, but its free-tier rpm is far
//                                   below Gemma's 30, so it's ruled out for a
//                                   game that fires calls in bursts
//   gemini-3.1-flash-lite  12.4s
//   gemma-4-26b-a4b-it     14.1s
//   gemini-3.5-flash-lite  times out entirely on this key — do not use
//
// Note the "-lite" naming is misleading here: 3.5-lite is unusable and 3.1-lite
// is barely faster than Gemma. Expect roughly 12-14s per chat reply.
//
// Each list is a fallback chain, tried in order, so a rate limit or transient
// failure on the first model falls through instead of failing the call. The two
// chains lead with different models on purpose: that splits load across two
// separate quota pools, so end-of-day batch work (which fires ~9 calls at once)
// doesn't exhaust the same budget the player's chat depends on. Batch leads with
// Gemma because it has the higher rpm and is what the prompts were tuned against.
const DIALOGUE_MODELS = ['gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it'] as const;
const BATCH_MODELS = ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite'] as const;

async function generateWithFallback(models: readonly string[], prompt: string): Promise<string> {
  const failures: string[] = [];

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({ model, contents: prompt });
      if (response.text) {
        return response.text;
      }
      failures.push(`${model}: returned no text`);
    } catch (err) {
      failures.push(`${model}: ${(err as Error).message}`);
    }
  }

  // Only reached when every model in the chain failed, so the message lists
  // all of them — debugging one exhausted chain from a single error is worse.
  throw new Error(`all models failed — ${failures.join('; ')}`);
}

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

// RelationshipStage now lives in lib/relationship.ts (Stranger ->
// Acquaintance -> Friend -> Close Friend) — the "4 stages vs 5
// tiers" doc ambiguity is resolved there: tiers are a finer split
// used only for diary voice, not a separate stage.

export interface DialogueResult {
  reply: string;
}

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
  const text = await generateWithFallback(DIALOGUE_MODELS, prompt);

  return parseDialogueResult(text);
}

// ============================================================
// End-of-day batch eval calls. Each follows the same three-part
// shape as generateDialogue above (buildXPrompt -> parseXResult ->
// generateX) — reuse that structure rather than reinventing it.
// ============================================================

export interface AffectionDeltaResult {
  delta: number;
}

// Only 'hiyori' | 'yuki' have an affection meter (Shiori doesn't,
// per game_state's columns) — narrower than NPCCharacter on purpose.
function buildAffectionDeltaPrompt(
  character: 'hiyori' | 'yuki',
  messages: DialogueTurn[],
  currentAffection: number,
  currentStage: RelationshipStage
): string {
  const name = character[0].toUpperCase() + character.slice(1);

  const messagesText = messages.length > 0
    ? messages.map((turn) => `${turn.role === 'player' ? 'Player' : name}: ${turn.content}`).join('\n')
    : '(No messages yet.)';

  return `You are an emotional-continuity evaluator for a narrative dating simulation — NOT ${name} herself, and nothing you write here is ever shown to the player. Your only job is to judge how today's conversation between Adrian (the player) and ${name} would realistically move her hidden affection toward him.

${name.toUpperCase()}'S PERSONALITY (use this to judge how SHE specifically would react, not a generic person):
${PERSONAS[character]}

CURRENT AFFECTION: ${currentAffection}/100
CURRENT RELATIONSHIP STAGE: ${currentStage}
Weigh the conversation against where she already is — the same warm gesture should move the needle more early on (Stranger/Acquaintance) than once she's already Close Friend, and a guarded personality should shift in small increments even when a conversation goes well.

TODAY'S CONVERSATION:
${messagesText}

Judge the delta on:
- Did Adrian say or do something that respects, amuses, or genuinely connects with her — or something generic, careless, or off-putting given who she is?
- Effort and attentiveness matter more than surface politeness.
- No conversation today, or a flat/neutral one, should produce a delta near 0 — don't invent movement that isn't there.
- Stay within -8 to +8. Daily conversation should never swing affection as hard as a major life event would — those are scored separately and can cross bigger thresholds (see the ±15 diary-trigger check elsewhere in this codebase); keeping chat's range well under that keeps the two systems from stepping on each other.

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "delta": <integer from -8 to 8> }`;
}

function parseAffectionDeltaResult(rawText: string): AffectionDeltaResult {
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

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { delta: unknown }).delta !== 'number') {
    throw new Error(`Gemma response did not match the expected shape: ${rawText}`);
  }

  const rawDelta = (parsed as { delta: number }).delta;

  // The -8..+8 bound is only a prompt instruction, not something the
  // model reliably respects — clamp (don't throw) so an occasional
  // Gemma overshoot degrades to "capped delta" instead of crashing the
  // whole batch eval. Round first so a stray non-integer (e.g. 3.7)
  // doesn't slip into game_state.affection, which is an int column.
  const delta = Math.max(-8, Math.min(8, Math.round(rawDelta)));

  return { delta };
}

export async function generateAffectionDelta(
  character: 'hiyori' | 'yuki',
  messages: DialogueTurn[],
  currentAffection: number,
  currentStage: RelationshipStage
): Promise<AffectionDeltaResult> {
  const prompt = buildAffectionDeltaPrompt(character, messages, currentAffection, currentStage);

  const text = await generateWithFallback(BATCH_MODELS, prompt);

  return parseAffectionDeltaResult(text);
}

export interface KnowledgeUpdateResult {
  content: string;
}

// Produces the TEXT that becomes a new dynamic lore_chunks row
// (is_static: false, session_id set) for one NPC — what `character`
// now personally knows/feels about Adrian after today, written the
// way an existing lore chunk reads, not as dialogue. Only ever given
// this character's own conversation (caller's job to scope it that
// way) — per README's siloed-knowledge design, no cross-NPC gossip.
// What happened outside conversation today — an event that fired and what
// Adrian chose to do about it. Without these the knowledge base only ever
// reflects chat, so a character would have no memory of events she was
// personally present for.
export interface KnowledgeEventContext {
  description: string;
  playerAction: string;
}

function buildKnowledgeUpdatePrompt(
  character: NPCCharacter,
  messages: DialogueTurn[],
  events: KnowledgeEventContext[]
): string {
  const name = character[0].toUpperCase() + character.slice(1);

  const messagesText = messages.length > 0
    ? messages.map((turn) => `${turn.role === 'player' ? 'Adrian' : name}: ${turn.content}`).join('\n')
    : '(No conversation with Adrian today.)';

  const eventsText = events.length > 0
    ? events.map((event, i) => `${i + 1}. ${event.description}\n   What Adrian did: ${event.playerAction}`).join('\n')
    : '(Nothing happened beyond conversation.)';

  return `You are updating ${name}'s private knowledge base in a narrative dating simulation — a factual record of what SHE personally knows or perceives about Adrian, not dialogue and never shown to the player directly.

${name.toUpperCase()}'S PERSONALITY (shapes how she'd interpret today, not what she says out loud):
${PERSONAS[character]}

TODAY'S CONVERSATION WITH ADRIAN:
${messagesText}

WHAT ELSE HAPPENED TODAY THAT ${name.toUpperCase()} WAS PART OF:
${eventsText}

Write 2-4 sentences, third person. Draw on both the conversation and the events above — an event she was present for tells her as much about him as anything he said. This must be about ADRIAN — his actions today and what they reveal — filtered through ${name}'s perspective, NOT a description of ${name} herself or her own state. Get the subject right: sentences should read like "Adrian did/said X — ${name} took that to mean Y," never "${name} felt/looked/was X." Capture only what ${name} learned or came to feel about Adrian from TODAY's interaction — not a restatement of things she already knew before today. Stay consistent with her personality: a guarded character notices more than she'd ever say, a direct character forms clearer opinions outright, etc. If nothing meaningful happened today, write one short sentence acknowledging that instead of inventing detail.

Example of the right subject/perspective: "Adrian noticed she seemed stressed and asked about it without making a big deal of it — ${name} found that oddly considerate, though she'd never admit it out loud." (Adrian's action is the subject; ${name}'s reaction is the interpretation layered on top, not the main subject.)

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "content": "<2-4 sentence third-person update>" }`;
}

function parseKnowledgeUpdateResult(rawText: string): KnowledgeUpdateResult {
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

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { content: unknown }).content !== 'string') {
    throw new Error(`Gemma response did not match the expected shape: ${rawText}`);
  }

  return { content: (parsed as { content: string }).content };
}

export async function generateKnowledgeUpdate(
  character: NPCCharacter,
  messages: DialogueTurn[],
  events: KnowledgeEventContext[] = []
): Promise<KnowledgeUpdateResult> {
  const prompt = buildKnowledgeUpdatePrompt(character, messages, events);

  const text = await generateWithFallback(BATCH_MODELS, prompt);

  return parseKnowledgeUpdateResult(text);
}

// Matches diary_system.md's prompt template placeholders exactly.
export interface DiaryEntryContext {
  day: number;
  tierLabel: string; // relationship.ts's tierLabel(tier) — label only, never the number
  relationshipStage: RelationshipStage;
  eventSummary: string; // "nothing notable" if no event today
  adrianAction: string; // player's last meaningful action/choice today
  lastEntries: string[]; // order (oldest/newest first) is the caller's convention — this just numbers them in the order given
}

export interface DiaryEntryResult {
  entry: string;
}

// Adapted from diary_system.md's "SYSTEM PROMPT FOR DIARY GENERATION"
// template verbatim — that section is already fully spec'd, so this
// just slots DiaryEntryContext's fields into its placeholders rather
// than reinventing the voice guidelines.
function buildDiaryPrompt(context: DiaryEntryContext): string {
  const lastEntriesText = context.lastEntries.length > 0
    ? context.lastEntries.map((entry, i) => `${i + 1}. ${entry}`).join('\n\n')
    : '(No previous entries — this is the first one.)';

  return `You are writing a private diary entry for Hiyori Mizuki, a 20-year-old Life Sciences student at NUS. This is her personal journal — she is honest with herself here in a way she isn't with other people, but she also deflects and minimizes, especially about her feelings for someone she is starting to notice.

Voice guidelines:
- Casual, personal, sometimes mid-thought
- She doesn't write in neat paragraphs — she trails off, backtracks, changes subject
- She mentions mundane things alongside significant ones (lab reports, food, tiredness)
- She does NOT dramatically declare feelings — she might mention someone in passing, note something they did, then immediately write about something unrelated
- The more she likes someone, the MORE she downplays it in writing
- She uses dry humor when she's uncomfortable about something
- She never writes anyone's name with hearts or dramatic language
- She is self-aware but not always honest with herself

Affection context: ${context.tierLabel}
Relationship stage: ${context.relationshipStage}
Today's events: ${context.eventSummary}
What Adrian did/said: ${context.adrianAction}
Previous entries:
${lastEntriesText}
Current in-game day: Day ${context.day} of 30

Write a diary entry for tonight. 150-250 words. Do not start with "Dear Diary." Do not mention affection scores or game mechanics. Write as Hiyori would write. Tag the entry with: [Day ${context.day} — In-game]

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "entry": "<the full diary entry text, including the [Day ${context.day} — In-game] tag>" }`;
}

function parseDiaryResult(rawText: string): DiaryEntryResult {
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

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { entry: unknown }).entry !== 'string') {
    throw new Error(`Gemma response did not match the expected shape: ${rawText}`);
  }

  return { entry: (parsed as { entry: string }).entry };
}

export async function generateDiaryEntry(context: DiaryEntryContext): Promise<DiaryEntryResult> {
  const prompt = buildDiaryPrompt(context);

  const text = await generateWithFallback(BATCH_MODELS, prompt);

  return parseDiaryResult(text);
}

// ============================================================
// Event outcome scoring.
//
// The player answers an event in free text describing what they'd do,
// which gets stored on the events_log row (player_action) during the
// day and scored here at end-of-day rather than inline. Deferring it is
// deliberate: activity segments run against a live clock, and a Gemma
// call mid-segment would stall it for the length of a round trip. The
// batch eval is already several sequential calls that nobody waits on.
// ============================================================

export interface EventOutcomeResult {
  // Which of the event's three written outcomes the response best matches.
  // Returned alongside the delta so the caller can show the matching
  // outcome text without having to re-derive it from the number.
  tier: 'high' | 'mid' | 'low';
  delta: number;
}

export interface EventOutcomeContext {
  // Only 'hiyori' | 'yuki' have a meter — see lib/events.ts's affectedMeter,
  // which resolves Shiori-focused events onto Hiyori's.
  character: 'hiyori' | 'yuki';
  eventDescription: string;
  actionPrompt: string;
  // The event's own affection_outcomes block from events.json, verbatim —
  // these are the grading criteria, not choices the player picked from.
  outcomes: { high: string; mid: string; low: string };
  playerAction: string;
  currentAffection: number;
  currentStage: RelationshipStage;
}

function buildEventOutcomePrompt(context: EventOutcomeContext): string {
  const name = context.character[0].toUpperCase() + context.character.slice(1);

  return `You are an emotional-continuity evaluator for a narrative dating simulation — NOT ${name} herself, and nothing you write here is ever shown to the player. Judge how the player's handling of a specific event would realistically move ${name}'s hidden affection toward him.

${name.toUpperCase()}'S PERSONALITY (judge how SHE specifically would react, not a generic person):
${PERSONAS[context.character]}

CURRENT AFFECTION: ${context.currentAffection}/100
CURRENT RELATIONSHIP STAGE: ${context.currentStage}
Weigh the response against where she already is — the same gesture moves the needle more early on than once she's already Close Friend, and a guarded personality shifts in small increments even when something goes well.

WHAT HAPPENED:
${context.eventDescription}

THE SITUATION HE FACED:
${context.actionPrompt}

HOW THIS EVENT IS GRADED (written for this specific event — grade against these, not your own standard):
- A strong response looks like: ${context.outcomes.high}
- An adequate response looks like: ${context.outcomes.mid}
- A poor response looks like: ${context.outcomes.low}

WHAT ADRIAN (the player) SAID HE WOULD DO:
"${context.playerAction}"

Pick the tier his response best matches, then a delta:
- "high" -> +6 to +15
- "mid" -> -2 to +5
- "low" -> -15 to -2
Judge what he actually described doing, not what he claims about himself. A response that ignores the situation, is empty, or is nonsense is "low". Do not reward stated good intentions that the described action doesn't back up. Events can swing affection harder than ordinary conversation does — a genuinely significant moment handled well or badly is allowed to reach the ends of these ranges.

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "tier": "<high|mid|low>", "delta": <integer> }`;
}

// Per-tier clamps, so a tier/delta disagreement can't produce something
// self-contradictory like tier "low" with a +12 delta.
const TIER_DELTA_BOUNDS: Record<EventOutcomeResult['tier'], { min: number; max: number }> = {
  high: { min: 6, max: 15 },
  mid: { min: -2, max: 5 },
  low: { min: -15, max: -2 },
};

function parseEventOutcomeResult(rawText: string): EventOutcomeResult {
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

  const candidate = parsed as { tier?: unknown; delta?: unknown };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof candidate.delta !== 'number' ||
    (candidate.tier !== 'high' && candidate.tier !== 'mid' && candidate.tier !== 'low')
  ) {
    throw new Error(`Gemma response did not match the expected shape: ${rawText}`);
  }

  // Same reasoning as parseAffectionDeltaResult: the ranges are prompt
  // instructions, not something the model reliably respects, so clamp rather
  // than throw — an overshoot degrades to a capped delta instead of failing
  // the whole batch eval. Round first so a stray non-integer can't reach
  // game_state.affection, which is an int column.
  const bounds = TIER_DELTA_BOUNDS[candidate.tier];
  const delta = Math.max(bounds.min, Math.min(bounds.max, Math.round(candidate.delta)));

  return { tier: candidate.tier, delta };
}

export async function generateEventOutcome(context: EventOutcomeContext): Promise<EventOutcomeResult> {
  const prompt = buildEventOutcomePrompt(context);

  const text = await generateWithFallback(BATCH_MODELS, prompt);

  return parseEventOutcomeResult(text);
}
