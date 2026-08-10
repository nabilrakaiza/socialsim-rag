// ============================================================
// lib/chat.ts
//
// Single-turn chat handling — the "read path" companion to
// lib/batch-eval.ts's write path. Ties together:
//   lib/supabase.ts   (matchLoreHybrid, getMessagesForDay, insertMessage)
//   lib/gemma.ts       (generateDialogue)
//   lib/embeddings.ts  (embedText, for the retrieval query)
//
// Scope: one player message -> one NPC reply, persisted to `messages`.
// Does NOT touch affection/knowledge/diary — that's the end-of-day
// batch eval's job, not per-message (see lib/gemma.ts's header for
// why affection scoring is deliberately deferred).
//
// Does NOT enforce the day's time limits — that's lib/orchestrator.ts's job,
// same boundary reasoning as batch-eval.ts's day-advancement note.
// ============================================================

import { embedText } from './embeddings';
import { matchLoreHybrid, getMessagesForDay, insertMessage } from './supabase';
import { needsRetrieval } from './query-intent';
import { generateDialogue } from './gemma';
import type { NPCCharacter } from './gemma';
import type { RelationshipStage } from './relationship';

export interface SendMessageInput {
  sessionId: string;
  character: NPCCharacter;
  day: number;
  relationshipStage: RelationshipStage;
  playerMessage: string;
}

export interface SendMessageResult {
  reply: string;
}

export async function sendPlayerMessage(input: SendMessageInput): Promise<SendMessageResult> {
  // "morning" needs no memory, and retrieval had no way to say so — it
  // returned five unrelated chunks presented to the model as things she knows.
  // Checked before embedding, so a greeting costs no API call at all.
  // buildPrompt renders an empty set as "(Nothing specific comes to mind.)".
  //
  // Hybrid rather than vector-only: cosine alone cannot rank a short
  // conversational message — every chunk lands within ~0.03 of every other, so
  // the ordering is close to arbitrary. Fusing full-text search with the
  // vector arm took rank-1 hits from 8 of 17 golden cases to 13.
  // See supabase/migrations/0001_hybrid_search.sql.
  const retrievedLoreChunks = needsRetrieval(input.playerMessage)
    ? await matchLoreHybrid(
        await embedText(input.playerMessage),
        input.playerMessage,
        input.character,
        input.sessionId
      )
    : [];

  // getMessagesForDay returns every character's turns for the day, not just
  // this one — has to be filtered before it can stand in as this NPC's history.
  const todayMessages = await getMessagesForDay(input.sessionId, input.day);
  const history = todayMessages.filter(m => m.character == input.character);

  const { reply } = await generateDialogue(input.character, input.playerMessage, retrievedLoreChunks, history, input.relationshipStage);

  // Persisted after generateDialogue, not before — so this turn doesn't see
  // itself as part of its own history.
  await insertMessage({
    session_id: input.sessionId,
    character: input.character,
    day: input.day,
    role: 'player',
    content: input.playerMessage
  });

  await insertMessage({
    session_id: input.sessionId,
    character: input.character,
    day: input.day,
    role: 'npc',
    content: reply
  });

  return { reply };
}
