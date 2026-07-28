// ============================================================
// lib/chat.ts
//
// Single-turn chat handling — the "read path" companion to
// lib/batch-eval.ts's write path. Ties together:
//   lib/supabase.ts   (matchLoreChunks, getMessagesForDay, insertMessage)
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
import { matchLoreChunks, getMessagesForDay, insertMessage } from './supabase';
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
  const embedding = await embedText(input.playerMessage);
  const retrievedLoreChunks = await matchLoreChunks(embedding, input.character, input.sessionId);

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
