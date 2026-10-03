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
import { adrianProfileFor } from './adrian-profile';
import type { RelationshipStage } from './relationship';

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });

// Model choice, measured rather than assumed. On the real dialogue prompt
// (persona + retrieved lore + history, ~1240 tokens), re-measured 2026-10-03
// with scripts/tmp-bench-flash-lite.ts:
//
//   gemini-3.5-flash-lite  1.0-1.8s over 8 runs; 9 concurrent calls all ok
//   gemini-3.1-flash-lite  0.8-1.6s in one pass, 2.1-9.3s in the next — as
//                          fast at its best, but much less steady
//   gemma-4-26b-a4b-it     ~14s (not re-measured)
//   gemini-3.6-flash       ruled out: its free-tier rpm is far below Gemma's
//                          30, no good for a game that fires calls in bursts
//
// These drift. Three months earlier 3.5-lite timed out on every call with this
// key and 3.1-lite took 12s — so re-run the benchmark before trusting any of
// the numbers above, and keep the slower models in the chain rather than
// assuming today's fastest stays that way.
//
// Each list is a fallback chain, tried in order, so a rate limit, exhausted
// quota or timeout on the first model falls through instead of failing the
// call. The dialogue and batch chains lead with different models on purpose:
// that splits load across separate quota pools, so end-of-day batch work (which
// fires ~9 calls at once) doesn't exhaust the same budget the player's chat
// depends on. Batch leads with Gemma because it has the higher rpm and is what
// the prompts were tuned against.
const DIALOGUE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it'] as const;
const BATCH_MODELS = ['gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite'] as const;

// A call that hangs never throws, so without a deadline the chain would sit on
// its first model forever instead of falling through — which is exactly how
// 3.5-lite used to fail. Flash-lite answers in a second or two when healthy, so
// 20s is long past "slow" and into "not coming". Gemma gets no deadline: a
// diary entry legitimately takes it about a minute.
const FLASH_LITE_TIMEOUT_MS = 20_000;

function timeoutFor(model: string): number | undefined {
  return model.includes('flash-lite') ? FLASH_LITE_TIMEOUT_MS : undefined;
}

async function generateWithFallback(models: readonly string[], prompt: string): Promise<string> {
  const failures: string[] = [];

  for (const model of models) {
    try {
      const timeout = timeoutFor(model);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        ...(timeout ? { config: { httpOptions: { timeout } } } : {}),
      });
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


// What a character can tell about the time without being told a number.
//
// Passed as a phrase rather than the raw clock because that's how a person
// actually holds it: nobody thinks "it is 06:14", they think "it is early".
// Hiyori replied "It's barely seven" at 06:14 in a real playthrough — she was
// guessing, because the prompt gave her nothing. The exact time goes in too,
// but the phrase is what keeps the reply natural.
function timeOfDayPhrase(hour: number): string {
  if (hour < 5) return 'the middle of the night';
  if (hour < 8) return 'early morning';
  if (hour < 11) return 'mid-morning';
  if (hour < 13) return 'around midday';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'evening';
  if (hour < 23) return 'night';
  return 'very late at night';
}

export interface TemporalContext {
  /** In-game day, 1-30. */
  day: number;
  /** Hours since midnight — 6.25 is 06:15. */
  inGameHour: number;
  /** What she is in the middle of, if anything: "lunch", "in class". */
  activity?: string;
}

function buildTemporalBlock(context: TemporalContext): string {
  const hh = Math.floor(context.inGameHour);
  const mm = Math.floor((context.inGameHour - hh) * 60);
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  const lines = [
    `It is day ${context.day} of the semester, ${clock} — ${timeOfDayPhrase(context.inGameHour)}.`,
  ];
  if (context.activity) {
    lines.push(`She is in the middle of: ${context.activity}.`);
  }
  lines.push(
    'Let this colour the reply — how awake she is, whether she has time to talk, whether the hour is odd enough to remark on. Never recite the day number or the clock back at him unless it genuinely matters.'
  );
  return lines.join('\n');
}

// What she has already lived through today, outside this conversation.
//
// Nothing else in the prompt carries it. Retrieval only finds an event once
// end of day has written it into her knowledge base, so on the day itself she
// had no idea it happened: sit next to her in a lecture that morning, mention
// it at dinner, and she would invent an answer or just go along with him.
//
// The caller decides what belongs here — only beats that have actually
// happened by now, and only ones this character was present for. See
// lib/chat.ts.
export interface TodayContext {
  /** Beats from earlier today, in the order they happened. */
  events: KnowledgeEventContext[];
  /** A multi-day arc she is part of that is running right now. */
  ongoingArc?: { title: string; description: string };
}

// Returns '' when there is nothing to say, so a quiet day adds no section at
// all rather than an empty heading the model might try to fill.
function buildTodayBlock(name: string, today: TodayContext): string {
  const parts: string[] = [];

  if (today.ongoingArc) {
    parts.push(`GOING ON THIS WEEK: ${today.ongoingArc.title} — ${today.ongoingArc.description}`);
  }
  if (today.events.length > 0) {
    const list = today.events
      .map((event, i) => `${i + 1}. ${event.description}\n   What Adrian did: ${event.playerAction}`)
      .join('\n');
    parts.push(`EARLIER TODAY, before this conversation:\n${list}`);
  }
  if (parts.length === 0) return '';

  return `WHAT ${name.toUpperCase()} HAS BEEN THROUGH WITH ADRIAN — she was there for all of it. It is written from his side, so "you" below means Adrian:
${parts.join('\n\n')}
This is her own day, not news to her. If he brings any of it up she remembers it and has her own take on it; otherwise let it sit in the background and don't recite it.

`;
}

function buildPrompt(
  character: NPCCharacter,
  playerMessage: string,
  chunks: MatchedChunk[],
  history: DialogueTurn[],
  relationshipStage: RelationshipStage,
  temporal: TemporalContext,
  today: TodayContext
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

WHAT ${name.toUpperCase()} KNOWS ABOUT ADRIAN (the player) — stable background, not something he said today:
${adrianProfileFor(character)}

WHEN THIS IS HAPPENING:
${buildTemporalBlock(temporal)}

CURRENT RELATIONSHIP STAGE WITH THE PLAYER: ${relationshipStage}
Let this stage guide your warmth/guardedness — earlier stages should read more reserved, later stages more open. Never state the stage name or any numeric score out loud.

RELEVANT MEMORY (things ${name} knows, from the story so far):
${memoryText}

${buildTodayBlock(name, today)}CONVERSATION SO FAR:
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
  relationshipStage: RelationshipStage,
  temporal: TemporalContext,
  today: TodayContext = { events: [] }
): Promise<DialogueResult> {
  const prompt = buildPrompt(character, playerMessage, chunks, history, relationshipStage, temporal, today);

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
  /**
   * Whether today actually revealed anything about Adrian.
   *
   * False is common and correct: a day where he only asked questions tells a
   * character nothing about him. Those days used to be written as "Nothing
   * meaningful happened regarding Adrian today", embedded, and stored as a
   * retrievable chunk — four of one ten-day run's seven, all paraphrases of
   * each other, sitting in the pool as things she supposedly knows.
   *
   * A model-reported flag rather than pattern-matching the prose, which would
   * break the moment the wording drifted.
   */
  notable: boolean;
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

Write 2-4 sentences, third person. Draw on both the conversation and the events above — an event she was present for tells her as much about him as anything he said. This must be about ADRIAN — his actions today and what they reveal — filtered through ${name}'s perspective, NOT a description of ${name} herself or her own state. Get the subject right: sentences should read like "Adrian did/said X — ${name} took that to mean Y," never "${name} felt/looked/was X." Capture only what ${name} learned or came to feel about Adrian from TODAY's interaction — not a restatement of things she already knew before today. Stay consistent with her personality: a guarded character notices more than she'd ever say, a direct character forms clearer opinions outright, etc. Set "notable" to false ONLY when there is genuinely nothing about Adrian to record — a greeting, a logistics exchange, or a conversation where he said nothing of his own. Err toward true: a thin observation is worth keeping, and asking a question that shows he was paying attention, or remembering something, or how he reacted to what she said, all count as revealing. False is for empty exchanges, not merely modest ones. When it is false, still write one short sentence for "content" saying so; it will not be stored.

Example of the right subject/perspective: "Adrian noticed she seemed stressed and asked about it without making a big deal of it — ${name} found that oddly considerate, though she'd never admit it out loud." (Adrian's action is the subject; ${name}'s reaction is the interpretation layered on top, not the main subject.)

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary before or after it:
{ "content": "<2-4 sentence third-person update>", "notable": <true or false> }`;
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

  // Defaults to true when the model omits the field: a missing flag should
  // keep a real observation rather than silently discard it. The failure that
  // matters is losing a memory, not storing one extra.
  const notable = (parsed as { notable?: unknown }).notable;

  return {
    content: (parsed as { content: string }).content,
    notable: notable === undefined ? true : Boolean(notable),
  };
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

// ============================================================
// Ending reflections.
//
// Both of these are prose in a character's own voice, which makes them the one
// place the fast model is a better fit rather than a compromise. Flash-lite
// was ruled out of batch work because it wrote first person where third person
// was required — here first person is exactly what's wanted, and it runs in
// about a second against Gemma's twenty. That matters at the ending, which is
// the moment a player least wants to sit watching a spinner.
// ============================================================

const REFLECTION_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it'] as const;

export type EndingKind = 'good_end' | 'friend_zone_end' | 'bad_end' | 'too_late_end' | 'secret_end';

export interface FinalReflectionContext {
  ending: EndingKind;
  day: number;
  tierLabel: string;
  relationshipStage: RelationshipStage;
  /** Her own entries across the run, oldest first. */
  pastEntries: string[];
  /** What she came to know about Adrian, from her knowledge base. */
  impressions: string[];
}

// Being rejected and then reading a long post-mortem about why is punishing.
// The friend-zone ending gets the fullest treatment on purpose: being liked
// but not that way is the outcome most worth understanding.
const REFLECTION_LENGTH: Record<EndingKind, string> = {
  good_end: '200-280 words',
  friend_zone_end: '220-300 words',
  bad_end: '90-130 words',
  too_late_end: '200-280 words',
  secret_end: '180-240 words',
};

// Every clause names Hiyori explicitly rather than using a pronoun. These
// strings are shared with Yuki's epilogue, and in a prompt that is otherwise
// entirely about Yuki, "she turned him down" was read as Yuki doing the
// turning down — inventing a rejection that never happened.
const ENDING_FRAMING: Record<EndingKind, string> = {
  good_end: 'Adrian told Hiyori how he felt today, and Hiyori said yes to him.',
  friend_zone_end:
    'Adrian told Hiyori how he felt today. Hiyori turned him down — kindly, and Hiyori meant the kindness, but Hiyori turned him down.',
  bad_end:
    'Adrian told Hiyori how he felt today, long before Hiyori was anywhere near feeling the same. It was uncomfortable, and Hiyori said no to him.',
  too_late_end:
    'Thirty days passed and Adrian never said anything to Hiyori. Hiyori has just found out she is leaving on an overseas exchange, and the timing has closed the door on its own.',
  secret_end:
    'Adrian never said anything to Hiyori. Hiyori has heard, or worked out, that Adrian and Yuki have found their way to each other.',
};

function buildFinalReflectionPrompt(context: FinalReflectionContext): string {
  const entries = context.pastEntries.length > 0
    ? context.pastEntries.map((entry, i) => `${i + 1}. ${entry}`).join('\n\n')
    : '(She kept no diary over these weeks.)';

  const impressions = context.impressions.length > 0
    ? context.impressions.map((line) => `- ${line}`).join('\n')
    : '(Nothing much registered.)';

  return `You are writing the last diary entry Hiyori Mizuki writes about Adrian, on the night everything resolved. Same private journal as her earlier entries, same voice.

Voice guidelines:
- Casual, personal, sometimes mid-thought
- She trails off, backtracks, changes subject
- She mentions mundane things alongside significant ones
- She does NOT dramatically declare feelings — the more she means something, the more she downplays it
- Dry humour when she's uncomfortable
- Self-aware, but not always honest with herself

WHAT HAPPENED TODAY: ${ENDING_FRAMING[context.ending]}

HOW SHE HAD COME TO FEEL BY THEN: ${context.tierLabel}
Relationship stage reached: ${context.relationshipStage}
This is day ${context.day} of 30.

HER OWN DIARY, THESE PAST WEEKS:
${entries}

WHAT SHE HAD NOTICED ABOUT HIM ALONG THE WAY:
${impressions}

Write that final entry, ${REFLECTION_LENGTH[context.ending]}. This one is doing a particular job: a reader should finish it understanding why it went the way it did. So let her look back — reference specific things above, things he actually did or failed to do, and let the reasons show through what she chooses to dwell on. Not a summary and not a verdict; she is thinking on paper, and the explanation is a side effect of that.

Do not start with "Dear Diary". Do not mention scores, meters, points or game mechanics. Tag the entry with: [Day ${context.day} — In-game]

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary:
{ "entry": "<the full diary entry, including the [Day ${context.day} — In-game] tag>" }`;
}

export async function generateFinalReflection(context: FinalReflectionContext): Promise<DiaryEntryResult> {
  const text = await generateWithFallback(REFLECTION_MODELS, buildFinalReflectionPrompt(context));
  return parseDiaryResult(text);
}

export interface YukiEpilogueContext {
  /** Her hidden meter, 0-100. Decides whether there is anything to tell. */
  yukiAffection: number;
  /** What Yuki came to know about Adrian this run. */
  impressions: string[];
  /** So the epilogue knows what it is reacting to. */
  ending: EndingKind;
}

function buildYukiEpiloguePrompt(context: YukiEpilogueContext): string {
  const impressions = context.impressions.length > 0
    ? context.impressions.map((line) => `- ${line}`).join('\n')
    : '(They barely crossed paths.)';

  // Restraint is the character, not a limitation of the format: she has never
  // said any of this out loud and mostly talked herself out of it years ago.
  const weight = context.yukiAffection >= 50
    ? 'She had come to feel a great deal, and never found a moment she trusted enough to say it.'
    : 'Something had started to stir, quietly, and had not gone very far before it was overtaken.';

  return `You are writing a short closing epilogue for Yuki, a side character in a narrative dating simulation, revealing what she never said out loud.

WHO SHE IS: Composed, thoughtful, a little guarded. Feels things deeply but processes privately. Reads people emotionally rather than analytically. Dry, understated humour once comfortable. Has had quiet, unspoken feelings for Adrian since secondary school that she mostly talked herself out of pursuing. Loyal, dependable, shows up without being asked. Would never confess unless his own attention made it surface — and it did not.

HOW FAR IT HAD GOT: ${weight}

WHAT SHE NOTICED ABOUT HIM OVER THESE WEEKS:
${impressions}

HOW IT ENDED FOR HIM, WITH HIYORI — NOT WITH YUKI: ${ENDING_FRAMING[context.ending]}

Yuki was not part of that. Nothing was ever said between Adrian and Yuki, in either direction: she did not confess, he did not approach her, and she has neither accepted nor refused anything. Do not write her as having done any of those.

Write ${context.yukiAffection >= 50 ? '110-160' : '60-90'} words, third person, present or near-past tense. This is the reader learning something the player never got told. Keep her restraint intact — she does not weep, does not resent anyone, and would be mortified to be caught feeling this openly. Understatement will land harder than anguish. Reference specific things above where you can.

Do not mention scores, meters or game mechanics. Do not have her confess, and do not resolve it — the point is that it stays unsaid.

Respond with ONLY a single JSON object — no markdown code fences, no extra commentary:
{ "epilogue": "<the closing passage>" }`;
}

export interface YukiEpilogueResult {
  epilogue: string;
}

function parseYukiEpilogue(rawText: string): YukiEpilogueResult {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Model response was not valid JSON: ${rawText}`);
  }

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { epilogue: unknown }).epilogue !== 'string') {
    throw new Error(`Model response did not match the expected shape: ${rawText}`);
  }

  return { epilogue: (parsed as { epilogue: string }).epilogue };
}

export async function generateYukiEpilogue(context: YukiEpilogueContext): Promise<YukiEpilogueResult> {
  const text = await generateWithFallback(REFLECTION_MODELS, buildYukiEpiloguePrompt(context));
  return parseYukiEpilogue(text);
}
