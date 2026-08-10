// ============================================================
// lib/batch-eval.ts
//
// End-of-day batch evaluation — the "write path" that mirrors
// scripts/ingest.ts's embed -> insert flow, but for LLM-generated
// dynamic content instead of static files. Ties together:
//   lib/relationship.ts  (tier/stage/diary-trigger logic)
//   lib/gemma.ts          (generateAffectionDelta/KnowledgeUpdate/DiaryEntry)
//   lib/supabase.ts       (game_state/messages/diary_entries + insertLoreChunks)
//
// Event integration is NOT derived internally. lib/orchestrator.ts owns
// event state and passes the results in (eventConcludedToday,
// canonEventToday, eventAffectionDelta, ...), so this function never
// touches events_log and keeps one job: score the day's conversation,
// write the affection/knowledge/diary results.
//
// Advancing the day is deliberately NOT this function's job — it evaluates
// the day that already happened, it doesn't decide when the next one starts.
// lib/orchestrator.ts's endDay owns that, and is the only place it happens.
//
// The 3 knowledge-update chains and 2 affection-delta calls below
// are independent of each other, so they run concurrently via
// Promise.all rather than one-at-a-time — Gemini's per-minute rate
// limits (30rpm Gemma generation, 100rpm embeddings) comfortably
// cover firing them all at once. Diary generation stays sequential
// after that, since it depends on the resolved hiyori affection
// total and the trigger check.
// ============================================================

import { embedText } from './embeddings';
import {
  getGameState,
  updateGameState,
  getMessagesForDay,
  getLastDiaryEntries,
  insertDiaryEntry,
  insertLoreChunks,
} from './supabase';
import {
  generateAffectionDelta,
  generateKnowledgeUpdate,
  generateDiaryEntry,
} from './gemma';
import type { NPCCharacter, DialogueTurn, DiaryEntryContext, KnowledgeEventContext } from './gemma';
import {
  affectionToStage,
  affectionToTier,
  tierLabel,
  checkDiaryTrigger,
} from './relationship';
import type { RelationshipStage } from './relationship';
import type { LoreChunk } from './chunking';

export interface BatchEvalInput {
  sessionId: string;
  eventConcludedToday?: boolean;
  canonEventToday?: boolean;
  eventSummary?: string; // for the diary prompt, if something happened
  adrianAction?: string; // player's last meaningful action/choice today
  // Today's event outcomes, already scored by the orchestrator (see
  // lib/gemma.ts's generateEventOutcome and lib/events.ts's skipPenalty).
  // Passed in rather than applied separately so affection is written in
  // exactly one place, and so a big event actually reaches the +/-15 diary
  // threshold below — that check reads total movement, and events scored
  // outside this function would be invisible to it.
  eventAffectionDelta?: number;
  eventYukiAffectionDelta?: number;
  // Today's events grouped by who was present, so each character's knowledge
  // update covers what she witnessed as well as what was said. Keyed by
  // participant rather than by whose meter moved — see lib/events.ts's
  // eventParticipant.
  eventContexts?: Partial<Record<NPCCharacter, KnowledgeEventContext[]>>;
  // Called as each phase begins, so a caller can report progress. End-of-day
  // takes well over a minute of sequential LLM work, and a bare spinner for
  // that long is indistinguishable from a hang.
  onProgress?: (stage: BatchEvalStage) => void;
}

export type BatchEvalStage = 'reflecting' | 'diary' | 'saving';

export interface BatchEvalResult {
  newAffection: number;
  newYukiAffection: number;
  newStage: RelationshipStage;
  diaryGenerated: boolean;
}

// Retries once after a 1-minute wait. Meant for the Gemini calls
// specifically (generation + embeddings) — running several at once
// makes an occasional transient/rate-limit failure more likely than
// the old one-at-a-time version, and waiting out a minute is enough
// to clear either rate limit window.
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.log('Gemini call failed, waiting 60s before retrying:', err);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return fn();
  }
}

interface KnowledgeChunkResult {
  chunk: LoreChunk;
  embedding: number[];
}

// Skips the call entirely (returns null) when there's nothing to summarize —
// don't spend an API call on "nothing happened today." An event with no
// conversation still counts as something worth recording, which is why both
// inputs are checked.
async function buildKnowledgeChunk(
  character: NPCCharacter,
  turns: DialogueTurn[],
  events: KnowledgeEventContext[],
  sessionId: string,
  day: number
): Promise<KnowledgeChunkResult | null> {
  if (turns.length === 0 && events.length === 0) return null;

  const update = await withRetry(() => generateKnowledgeUpdate(character, turns, events));

  // A day that revealed nothing about Adrian writes no chunk. It used to write
  // one anyway — "Nothing meaningful happened regarding Adrian today" — which
  // was then embedded and retrievable, so the model could be handed, as
  // memory, the fact that nothing happened. Four of one ten-day run's seven
  // knowledge chunks were that sentence, all paraphrases of each other,
  // clustering at 0.884 with one another.
  //
  // Not an edge case: any day where Adrian only asks questions is a day that
  // teaches a character nothing about him, and that is most days.
  //
  // Returning null here also skips the embedding call, so a quiet day costs
  // one LLM round trip instead of two.
  if (!update.notable) return null;

  // The day goes INTO the content, not just source_file. source_file is a
  // filing label: buildPrompt only ever passes chunk.content to the model, and
  // the embedding is computed from content alone — so a day recorded only
  // there is invisible to both the reader and the search. Without this a
  // character can recall that Adrian shared his umbrella and have no way to
  // know whether that was yesterday or three weeks ago.
  //
  // It also varies the text. Every knowledge chunk comes from one prompt with
  // one instruction, so by day 30 a character has ~30 chunks all reading
  // "Adrian did X — she took that to mean Y". That is a corpus engineered to
  // embed into a tight cluster; a distinct leading token is the cheapest
  // available separation.
  const dated = `[Day ${day}] ${update.content}`;
  const embedding = await withRetry(() => embedText(dated));

  return {
    chunk: {
      content: dated,
      is_static: false,
      session_id: sessionId,
      character,
      source_file: `dynamic-day-${day}`,
      chunk_index: 0,
    },
    embedding,
  };
}

// No messages today = no delta call = affection unchanged, not zeroed.
//
// Returns the raw delta rather than a finished total, because the caller
// adds event deltas to it before clamping and clamping twice gives a
// different answer: from 95, chat +8 then event -5 should land on 98, but
// clamping the chat step to 100 first turns it into 95.
async function buildChatAffectionDelta(
  character: 'hiyori' | 'yuki',
  turns: DialogueTurn[],
  currentAffection: number
): Promise<number> {
  if (turns.length === 0) {
    return 0;
  }

  const { delta } = await withRetry(() =>
    generateAffectionDelta(character, turns, currentAffection, affectionToStage(currentAffection))
  );
  return delta;
}

const clampAffection = (value: number): number => Math.min(Math.max(value, 0), 100);

export async function runEndOfDayBatchEval(input: BatchEvalInput): Promise<BatchEvalResult> {
  const gameState = await getGameState(input.sessionId);
  const messages = await getMessagesForDay(input.sessionId, gameState.current_day);

  const yukiMessages: DialogueTurn[] = messages.filter(m => m.character == "yuki").map(m => ({role: "npc", content: m.content}));
  const shioriMessages: DialogueTurn[] = messages.filter(m => m.character == "shiori").map(m => ({role: "npc", content: m.content}));
  const hiyoriMessages: DialogueTurn[] = messages.filter(m => m.character == "hiyori").map(m => ({role: "npc", content: m.content}));

  input.onProgress?.('reflecting');

  const [yukiChunk, shioriChunk, hiyoriChunk, yukiChatDelta, hiyoriChatDelta] = await Promise.all([
    buildKnowledgeChunk('yuki', yukiMessages, input.eventContexts?.yuki ?? [], input.sessionId, gameState.current_day),
    buildKnowledgeChunk('shiori', shioriMessages, input.eventContexts?.shiori ?? [], input.sessionId, gameState.current_day),
    buildKnowledgeChunk('hiyori', hiyoriMessages, input.eventContexts?.hiyori ?? [], input.sessionId, gameState.current_day),
    buildChatAffectionDelta('yuki', yukiMessages, gameState.yuki_affection),
    buildChatAffectionDelta('hiyori', hiyoriMessages, gameState.affection),
  ]);

  const knowledgeChunks = [yukiChunk, shioriChunk, hiyoriChunk].filter(
    (result): result is KnowledgeChunkResult => result !== null
  );

  if (knowledgeChunks.length > 0) {
    await insertLoreChunks(
      knowledgeChunks.map((c) => c.chunk),
      knowledgeChunks.map((c) => c.embedding)
    );
  }

  // Chat and event deltas are summed before a single clamp — see
  // buildChatAffectionDelta on why clamping each separately is wrong.
  const updatedYukiAffection = clampAffection(
    gameState.yuki_affection + yukiChatDelta + (input.eventYukiAffectionDelta ?? 0)
  );
  const updatedYukiStage = affectionToStage(updatedYukiAffection);
  const updatedHiyoriAffection = clampAffection(
    gameState.affection + hiyoriChatDelta + (input.eventAffectionDelta ?? 0)
  );
  const updatedHiyoriStage = affectionToStage(updatedHiyoriAffection);

  const mostRecentDiaryEntry = await getLastDiaryEntries(input.sessionId, 1);
  // no previous entry at all -> always trigger-eligible, not "0 days since"
  const lastDiaryDay = mostRecentDiaryEntry[0]?.day ?? -Infinity;

  const { shouldGenerate, triggerType } = checkDiaryTrigger({
    confessedToday: gameState.confessed,
    eventConcludedToday: input.eventConcludedToday ?? false,
    canonEventToday: input.canonEventToday ?? false,
    daysSinceLastEntry: gameState.current_day - lastDiaryDay,
    affectionDeltaToday: updatedHiyoriAffection - gameState.affection,
  });

  if (shouldGenerate) {
    input.onProgress?.('diary');

    const lastEntries = await getLastDiaryEntries(input.sessionId, 2);

    const diaryContext: DiaryEntryContext = {
      day: gameState.current_day,
      tierLabel: tierLabel(affectionToTier(updatedHiyoriAffection)),
      relationshipStage: updatedHiyoriStage,
      eventSummary: input.eventSummary ?? 'nothing notable',
      adrianAction: input.adrianAction ?? 'nothing notable',
      lastEntries: lastEntries.map(m => m.entry_text)
    };

    const { entry } = await withRetry(() => generateDiaryEntry(diaryContext));

    await insertDiaryEntry({
      session_id: input.sessionId,
      day: gameState.current_day,
      entry_text: entry,
      affection_tier: affectionToTier(updatedHiyoriAffection),
      trigger_type: triggerType!,
      event_id: null
    });

    const entryEmbedding = await withRetry(() => embedText(entry));
    const entryLoreChunk: LoreChunk = {
      content: entry,
      is_static: false,
      session_id: input.sessionId,
      character: 'hiyori',
      source_file: `dynamic-day-${gameState.current_day}`,
      // chunk_index 0 under this source_file is already taken by hiyori's knowledge-update chunk above (when she had messages today)
      chunk_index: 2
    };

    await insertLoreChunks([entryLoreChunk], [entryEmbedding]);
  }

  input.onProgress?.('saving');

  await updateGameState(input.sessionId, {
    affection: updatedHiyoriAffection,
    yuki_affection: updatedYukiAffection,
    relationship_stage: updatedHiyoriStage
  });

  return {
    newAffection: updatedHiyoriAffection,
    newYukiAffection: updatedYukiAffection,
    newStage: updatedHiyoriStage,
    diaryGenerated: shouldGenerate
  };
}
