// ============================================================
// lib/ending-reflection.ts
//
// What the player reads once the run is over.
//
// Everything here is built from content the game already generated and stored:
// Hiyori's diary, and each character's accumulated knowledge of Adrian. Until
// now none of it was ever shown — thirty days of retrieval feeding the model
// and nothing feeding the player. This is where that record gets read back.
//
// Deliberately separate from lib/orchestrator.ts: this runs after the game is
// over, changes no state, and is the only module that reads a whole session's
// memory rather than a slice of it.
// ============================================================

import { getGameState, getDiaryArchive, getDynamicChunks } from './supabase';
import { generateFinalReflection, generateYukiEpilogue } from './gemma';
import type { EndingKind } from './gemma';
import { affectionToStage, affectionToTier, tierLabel } from './relationship';

// Below this she genuinely didn't think about him much, and an epilogue would
// be inventing feelings the playthrough never earned.
const YUKI_REVEAL_FLOOR = 25;

export interface EndingReflection {
  /** Hiyori's closing entry, written the night it resolved. */
  finalEntry: string;
  /** Her earlier entries, oldest first — the evidence behind the closing one. */
  archive: { day: number; text: string }[];
  /** What Yuki never said. Null when there's nothing to tell, or she already said it. */
  yukiEpilogue: string | null;
}

export async function buildEndingReflection(sessionId: string): Promise<EndingReflection> {
  const gameState = await getGameState(sessionId);

  if (!gameState.game_over || !gameState.ending_id) {
    throw new Error('the run is not over');
  }
  const ending = gameState.ending_id as EndingKind;

  const [entries, hiyoriMemory, yukiMemory] = await Promise.all([
    getDiaryArchive(sessionId),
    getDynamicChunks(sessionId, 'hiyori'),
    getDynamicChunks(sessionId, 'yuki'),
  ]);

  // Hiyori's dynamic chunks hold two different things under one character:
  // her knowledge updates, and her diary entries indexed for retrieval. Only
  // the knowledge updates belong here — the diary is shown in full as the
  // archive, and feeding it back as "impressions" would just duplicate it.
  const archiveTexts = new Set(entries.map((entry) => entry.entry_text));
  const impressions = hiyoriMemory
    .map((chunk) => chunk.content)
    .filter((content) => !archiveTexts.has(content));

  // On the secret end Yuki already said it out loud, so there is nothing left
  // unsaid to reveal.
  const revealYuki = ending !== 'secret_end' && gameState.yuki_affection >= YUKI_REVEAL_FLOOR;

  const [final, yuki] = await Promise.all([
    generateFinalReflection({
      ending,
      day: gameState.current_day,
      tierLabel: tierLabel(affectionToTier(gameState.affection)),
      relationshipStage: affectionToStage(gameState.affection),
      pastEntries: entries.map((entry) => entry.entry_text),
      impressions,
    }),
    revealYuki
      ? generateYukiEpilogue({
          yukiAffection: gameState.yuki_affection,
          impressions: yukiMemory.map((chunk) => chunk.content),
          ending,
        })
      : Promise.resolve(null),
  ]);

  return {
    finalEntry: final.entry,
    archive: entries.map((entry) => ({ day: entry.day, text: entry.entry_text })),
    yukiEpilogue: yuki?.epilogue ?? null,
  };
}
