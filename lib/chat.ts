// ============================================================
// lib/chat.ts
//
// Single-turn chat handling — the "read path" companion to
// lib/batch-eval.ts's write path. Ties together:
//   lib/supabase.ts   (matchLoreHybrid, getMessagesForDay, insertMessage,
//                      getAllEventLogs)
//   lib/gemma.ts       (generateDialogue)
//   lib/embeddings.ts  (embedText, for the retrieval query)
//   lib/events.ts      (what today's events_log rows actually were)
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
import { matchLoreHybrid, getMessagesForDay, insertMessage, getAllEventLogs } from './supabase';
import { needsRetrieval } from './query-intent';
import { generateDialogue } from './gemma';
import type { NPCCharacter, TemporalContext, TodayContext } from './gemma';
import type { RelationshipStage } from './relationship';
import { loadEvents, findBeat, detailSeed, eventParticipant } from './events';
import { reconstructArcState } from './orchestrator';

export interface SendMessageInput {
  sessionId: string;
  character: NPCCharacter;
  day: number;
  relationshipStage: RelationshipStage;
  playerMessage: string;
  /**
   * Where the day is when this message is sent. The live clock is client-side
   * state (see app/useDayClock.ts) and deliberately not persisted, so the
   * caller is the only thing that knows it.
   */
  inGameHour: number;
  /** What she is in the middle of, if the current segment implies one. */
  activity?: string;
}

export interface SendMessageResult {
  reply: string;
}

// What `character` has already been through with Adrian today — see
// TodayContext in lib/gemma.ts for why the prompt needs it.
//
// Two filters, and both matter:
//
//   - Answered rows only. startDay resolves all three activity segments up
//     front, so the evening's event already has a row at breakfast. The clock
//     that says which segments are behind us is client state and never reaches
//     the database; a recorded response is the one server-side sign that a
//     beat has really taken place. A skipped beat is left out by the same
//     rule, which matches what end of day does with it — an event Adrian
//     didn't engage with isn't something she learned about him from.
//
//   - Her own events only, by participant rather than by whose meter moved.
//     Knowledge is siloed per character: Yuki wasn't in the lecture hall, and
//     Shiori's coffee with Adrian is Shiori's to remember even though it is
//     Hiyori's meter it moves.
//
// The grading criteria (affection_outcomes) are never passed on — only what
// happened and what he did.
async function getTodayContext(sessionId: string, day: number, character: NPCCharacter): Promise<TodayContext> {
  const logs = await getAllEventLogs(sessionId);
  const events = loadEvents();
  const today: TodayContext = { events: [] };

  const { activeArc } = reconstructArcState(logs, day);
  if (activeArc && eventParticipant(activeArc.event) === character) {
    today.ongoingArc = { title: activeArc.event.title, description: activeArc.event.description };
  }

  const answeredToday = logs
    .filter((row) => row.day_triggered === day && row.player_action?.trim())
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  for (const row of answeredToday) {
    const ref = findBeat(row.event_id, events, detailSeed(row.session_id, row.day_triggered));
    // No match means events.json changed under an existing save.
    if (!ref || eventParticipant(ref.parent) !== character) continue;
    // A top-level event's title can hold a detail its description doesn't —
    // "Coincidence [Location]" is the only place that event says where it
    // was — so both go in. Sub-events have no title.
    const description = 'title' in ref.beat ? `${ref.beat.title} — ${ref.beat.description}` : ref.beat.description;
    today.events.push({ description, playerAction: row.player_action!.trim() });
  }

  return today;
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
  const [todayMessages, today] = await Promise.all([
    getMessagesForDay(input.sessionId, input.day),
    getTodayContext(input.sessionId, input.day, input.character),
  ]);
  const history = todayMessages.filter(m => m.character == input.character);

  const temporal: TemporalContext = {
    day: input.day,
    inGameHour: input.inGameHour,
    activity: input.activity,
  };

  const { reply } = await generateDialogue(
    input.character,
    input.playerMessage,
    retrievedLoreChunks,
    history,
    input.relationshipStage,
    temporal,
    today
  );

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
