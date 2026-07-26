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
// Event integration (eventConcludedToday/canonEventToday below) is
// NOT derived internally — the event system doesn't exist yet, and
// events_log has no "concluded"/"canon" distinction defined to
// interpret. Caller supplies these explicitly; omitting them is
// correct for now since only chat exists.
//
// Day/action-point advancement is deliberately NOT this function's
// job — it evaluates the day that already happened, it doesn't
// decide when the next one starts. That's the caller's call.
//
// The 3 knowledge-update chains and 2 affection-delta calls below
// are independent of each other, so they run concurrently via
// Promise.all rather than one-at-a-time — Gemini's per-minute rate
// limits (30rpm Gemma generation, 100rpm embeddings) comfortably
// cover firing them all at once. Diary generation stays sequential
// after that, since it depends on the resolved hiyori affection
// total and the trigger check.
// ============================================================

import { embedText } from './embeddings.js';
import {
  getGameState,
  updateGameState,
  getMessagesForDay,
  getLastDiaryEntries,
  insertDiaryEntry,
  insertLoreChunks,
} from './supabase.js';
import {
  generateAffectionDelta,
  generateKnowledgeUpdate,
  generateDiaryEntry,
} from './gemma.js';
import type { NPCCharacter, DialogueTurn, DiaryEntryContext } from './gemma.js';
import {
  affectionToStage,
  affectionToTier,
  tierLabel,
  checkDiaryTrigger,
} from './relationship.js';
import type { RelationshipStage } from './relationship.js';
import type { LoreChunk } from './chunking.js';

export interface BatchEvalInput {
  sessionId: string;
  eventConcludedToday?: boolean;
  canonEventToday?: boolean;
  eventSummary?: string; // for the diary prompt, if something happened
  adrianAction?: string; // player's last meaningful action/choice today
}

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
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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
// don't spend an API call on "nothing happened today."
async function buildKnowledgeChunk(
  character: NPCCharacter,
  turns: DialogueTurn[],
  sessionId: string,
  day: number
): Promise<KnowledgeChunkResult | null> {
  if (turns.length === 0) return null;

  const update = await withRetry(() => generateKnowledgeUpdate(character, turns));
  const embedding = await withRetry(() => embedText(update.content));

  return {
    chunk: {
      content: update.content,
      is_static: false,
      session_id: sessionId,
      character,
      source_file: `dynamic-day-${day}`,
      chunk_index: 0,
    },
    embedding,
  };
}

interface AffectionUpdateResult {
  affection: number;
  stage: RelationshipStage;
}

// No messages today = no delta call = affection unchanged, not zeroed.
async function buildAffectionUpdate(
  character: 'hiyori' | 'yuki',
  turns: DialogueTurn[],
  currentAffection: number
): Promise<AffectionUpdateResult> {
  const currentStage = affectionToStage(currentAffection);

  if (turns.length === 0) {
    return { affection: currentAffection, stage: currentStage };
  }

  const { delta } = await withRetry(() =>
    generateAffectionDelta(character, turns, currentAffection, currentStage)
  );
  const affection = Math.min(Math.max(delta + currentAffection, 0), 100);
  return { affection, stage: affectionToStage(affection) };
}

export async function runEndOfDayBatchEval(input: BatchEvalInput): Promise<BatchEvalResult> {
  const gameState = await getGameState(input.sessionId);
  const messages = await getMessagesForDay(input.sessionId, gameState.current_day);

  const yukiMessages: DialogueTurn[] = messages.filter(m => m.character == "yuki").map(m => ({role: "npc", content: m.content}));
  const shioriMessages: DialogueTurn[] = messages.filter(m => m.character == "shiori").map(m => ({role: "npc", content: m.content}));
  const hiyoriMessages: DialogueTurn[] = messages.filter(m => m.character == "hiyori").map(m => ({role: "npc", content: m.content}));

  const [yukiChunk, shioriChunk, hiyoriChunk, yukiUpdate, hiyoriUpdate] = await Promise.all([
    buildKnowledgeChunk('yuki', yukiMessages, input.sessionId, gameState.current_day),
    buildKnowledgeChunk('shiori', shioriMessages, input.sessionId, gameState.current_day),
    buildKnowledgeChunk('hiyori', hiyoriMessages, input.sessionId, gameState.current_day),
    buildAffectionUpdate('yuki', yukiMessages, gameState.yuki_affection),
    buildAffectionUpdate('hiyori', hiyoriMessages, gameState.affection),
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

  const updatedYukiAffection = yukiUpdate.affection;
  const updatedYukiStage = yukiUpdate.stage;
  const updatedHiyoriAffection = hiyoriUpdate.affection;
  const updatedHiyoriStage = hiyoriUpdate.stage;

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
