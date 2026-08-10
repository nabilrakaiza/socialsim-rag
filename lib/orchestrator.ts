// ============================================================
// lib/orchestrator.ts
//
// The game loop — the only module that knows how a day actually runs.
// Everything else is deliberately unaware of the others: lib/events.ts
// is pure logic with no DB access, lib/chat.ts handles one message,
// lib/batch-eval.ts handles one end-of-day. This ties them together.
//
// Three entry points, matching what a frontend needs:
//   startNewGame()        -> mints a session
//   startDay()            -> the day's plan (schedule + what fires when)
//   recordEventResponse() -> the player's free text for one event
//   confess()             -> ends the run immediately with an ending
//   endDay()              -> score, evaluate, advance, check for an ending
//
// Schedule and clock state are NOT persisted (see README's Daily Flow):
// they live in the client for the length of a session. What IS persisted
// is events_log, which is the sole source of truth for event state —
// used arcs, the active arc, and which sub-events have fired are all
// reconstructed from those rows rather than stored separately.
//
// All three segments are resolved up front in startDay rather than
// lazily as the client reaches them. That's safe because affection and
// stage can't move mid-day — runEndOfDayBatchEval is the only thing that
// changes them — so resolving early gives identical results.
// ============================================================

import {
  getGameState,
  insertGameState,
  updateGameState,
  getAllEventLogs,
  getEventLogsForDay,
  claimDayForScoring,
  releaseDayScoringClaim,
  deleteEventLogsByIds,
  insertEventLog,
  updateEventLogAction,
  updateEventLogOutcome,
} from './supabase';
import type { EventLog, GameState } from './supabase';
import {
  loadEvents,
  checkExtendedEventTrigger,
  resolveActivitySegment,
  resolveActivitySegmentDuringArc,
  affectedMeter,
  applyRandomizedDetails,
  eventParticipant,
  skipPenalty,
} from './events';
import type {
  ActiveExtendedEvent,
  ActivitySegmentName,
  GameEvent,
  SubEvent,
  FlavorActivity,
} from './events';
import { generateDailySchedule } from './schedule';
import type { ScheduleSegment } from './schedule';
import { generateEventOutcome } from './gemma';
import type { KnowledgeEventContext, NPCCharacter } from './gemma';
import { runEndOfDayBatchEval, withRetry } from './batch-eval';
import type { BatchEvalStage } from './batch-eval';
import { checkEnding } from './endings';
import type { EndingId } from './endings';
import { affectionToStage, type RelationshipStage } from './relationship';

const ACTIVITY_SEGMENTS: ActivitySegmentName[] = [
  'morning_activity',
  'activity_after_lunch',
  'activity_after_dinner',
];

// What one activity segment turned into. `eventLogId` is set only when
// something fired — it's the handle the client passes back to
// recordEventResponse.
export interface ResolvedSegment {
  segment: ActivitySegmentName;
  flavor?: FlavorActivity;
  event?: GameEvent;
  subEvent?: SubEvent;
  eventLogId?: string;
}

export interface DayPlan {
  day: number;
  schedule: ScheduleSegment[];
  segments: ResolvedSegment[];
  startedArc: GameEvent | null;
  activeArc: ActiveExtendedEvent | null;
}

export interface EndDayResult {
  newAffection: number;
  newYukiAffection: number;
  newStage: RelationshipStage;
  diaryGenerated: boolean;
  // Split per meter rather than one total: the two are separate columns and
  // a combined number would be meaningless. Names match BatchEvalInput's.
  eventAffectionDelta: number;
  eventYukiAffectionDelta: number;
  ending: EndingId | null;
}

// ------------------------------------------------------------
// State reconstruction. events_log holds one row per fired event or
// sub-event; everything below is derived from those rows rather than
// stored, which is why the event system needed no schema change.
// ------------------------------------------------------------

interface ArcState {
  usedExtendedEventIds: string[];
  activeArc: ActiveExtendedEvent | null;
}

export function reconstructArcState(logs: EventLog[], currentDay: number): ArcState {
  const arcsById = new Map(
    loadEvents()
      .filter((event) => event.type === 'extended_event')
      .map((event) => [event.id, event])
  );

  // Rows whose event_id names an arc are arc *starts*; sub-event rows are
  // logged under their own ids and don't count here.
  const arcStarts = logs
    .filter((log) => arcsById.has(log.event_id))
    .sort((a, b) => a.day_triggered - b.day_triggered);

  const usedExtendedEventIds = arcStarts.map((log) => log.event_id);

  // An arc covers [start, start + duration - 1]. At most one can contain
  // today, since the trigger check only ever runs on an idle day.
  const activeStart = arcStarts.find((log) => {
    const arc = arcsById.get(log.event_id)!;
    return currentDay >= log.day_triggered && currentDay <= log.day_triggered + arc.duration_days - 1;
  });

  if (!activeStart) {
    return { usedExtendedEventIds, activeArc: null };
  }

  const arc = arcsById.get(activeStart.event_id)!;
  const subEventIds = new Set((arc.sub_events ?? []).map((sub) => sub.id));

  return {
    usedExtendedEventIds,
    activeArc: {
      event: arc,
      startDay: activeStart.day_triggered,
      firedSubEventIds: logs
        .filter((log) => subEventIds.has(log.event_id) && log.day_triggered >= activeStart.day_triggered)
        .map((log) => log.event_id),
    },
  };
}

// ------------------------------------------------------------
// Entry points
// ------------------------------------------------------------

// Mints a playthrough. The session id is the only handle the client keeps —
// there are no accounts, so whoever holds the id holds the save. That's why
// it's a UUID rather than anything guessable or sequential.
export async function startNewGame(): Promise<GameState> {
  return insertGameState(crypto.randomUUID());
}

// The stage is derived from affection rather than read off
// game_state.relationship_stage: that column is plain text with no
// constraint and is denormalized anyway, so deriving it is both correctly
// typed and immune to drift. See lib/supabase.ts's GameState.
export async function startDay(sessionId: string): Promise<DayPlan> {
  const gameState = await getGameState(sessionId);

  // Calling this twice for the same day used to double the day's beats: the
  // client keeps its plan in memory, so a refresh lost it, asked for a new one,
  // and the first set stayed behind as unanswered rows that collected skip
  // penalties at end of day — the player losing affection for reloading a page.
  //
  // Clearing unanswered beats first makes a re-roll replace the abandoned day
  // rather than stack on it. Two kinds of row are deliberately spared:
  //
  //   - answered beats, which are real choices the player already made
  //   - arc-start markers, which are unanswered by nature and always will be.
  //     Deleting those loses the arc entirely — reconstructArcState reads them
  //     to know an arc is running and how far in it is, so a re-roll would
  //     silently abandon a seven-day committee on day three and let an
  //     unrelated arc start in its place.
  const arcIdSet = new Set(
    loadEvents().filter((event) => event.type === 'extended_event').map((event) => event.id)
  );
  const today = await getEventLogsForDay(sessionId, gameState.current_day);
  const stale = today
    .filter((row) => row.player_action === null && !arcIdSet.has(row.event_id))
    .map((row) => row.id);

  if (stale.length > 0) {
    await deleteEventLogsByIds(stale);
    console.log(`[startDay] day ${gameState.current_day} re-rolled, discarded ${stale.length} unanswered beats`);
  }

  const allEventsLogs = await getAllEventLogs(sessionId);

  const arcState = reconstructArcState(allEventsLogs, gameState.current_day);
  const currentStage = affectionToStage(gameState.affection);

  let activeArc = arcState.activeArc;
  let startedArc: GameEvent | null = null;

  // Only an idle day can start an arc — one runs at a time.
  if (activeArc == null) {
    const extendedEventTrigger = checkExtendedEventTrigger({
      currentDay: gameState.current_day,
      currentStage,
      affection: gameState.affection,
      yukiAffection: gameState.yuki_affection,
      usedExtendedEventIds: arcState.usedExtendedEventIds
    });

    if (extendedEventTrigger) {
      // A marker row that the arc began — not a beat anyone answers, so it
      // stays unanswered forever and endDay skips it when scoring.
      await insertEventLog({
        session_id: sessionId,
        event_id: extendedEventTrigger.id,
        day_triggered: gameState.current_day,
        player_action: null,
        affection_delta: 0,
      });

      startedArc = extendedEventTrigger;
      activeArc = {
        event: extendedEventTrigger,
        startDay: gameState.current_day,
        firedSubEventIds: [],
      };
    }
  }

  const schedule = generateDailySchedule();
  const segments: ResolvedSegment[] = [];
  // Accumulated across segments so a regular event can't fire twice in one day.
  const firedTodayIds: string[] = [];

  for (const segment of ACTIVITY_SEGMENTS) {
    const gates = {
      segment,
      currentStage,
      affection: gameState.affection,
      yukiAffection: gameState.yuki_affection,
      firedTodayIds,
    };

    // Branched rather than a ternary on purpose: assigning either function's
    // result to one annotated const makes TS narrow at the declaration site
    // and collapse the union, which silently degrades `subEvent` to `never`.
    // Handling each call separately keeps both results concretely typed.
    let event: GameEvent;
    let subEvent: SubEvent | undefined;

    if (activeArc) {
      const arcResult = resolveActivitySegmentDuringArc({
        ...gates,
        currentDay: gameState.current_day,
        activeEvent: activeArc,
      });
      if (!arcResult.firedEvent) {
        segments.push({ segment, flavor: arcResult.flavor });
        continue;
      }
      event = arcResult.event;
      subEvent = arcResult.subEvent;
    } else {
      const plainResult = resolveActivitySegment(gates);
      if (!plainResult.firedEvent) {
        segments.push({ segment, flavor: plainResult.flavor });
        continue;
      }
      event = plainResult.event;
    }

    // Only top-level events are tracked — sub-events are meant to repeat.
    if (!subEvent) {
      firedTodayIds.push(event.id);
    }

    const row = await insertEventLog({
      session_id: sessionId,
      // sub-events are logged under their own id — that's what the arc's
      // force-out logic reads back on later days
      event_id: subEvent ? subEvent.id : event.id,
      day_triggered: gameState.current_day,
      player_action: null,
      affection_delta: 0,
    });

    // Fed back inside the loop, not after it: resolveActivitySegmentDuringArc
    // reads this to decide force-out and final-day guarantees, so without it
    // the same beat can fire in all three segments of one day.
    if (subEvent && activeArc && !activeArc.firedSubEventIds.includes(subEvent.id)) {
      activeArc.firedSubEventIds.push(subEvent.id);
    }

    segments.push({ segment, event, subEvent, eventLogId: row.id });
  }

  return { day: gameState.current_day, schedule, segments, startedArc, activeArc };
}

// Confessing ends the run there and then, rather than waiting for endDay.
// checkEnding treats a confession as resolving immediately — the player can
// shoot their shot at any point and the score only decides how it lands — so
// deferring it to the end of the day would leave the game in a state where
// the outcome is decided but not yet shown.
//
// Returns the ending so the caller can render it straight away. Note this
// never returns null: with confessed true, checkEnding always resolves to one
// of the three confession endings.
export async function confess(sessionId: string): Promise<EndingId> {
  const gameState = await getGameState(sessionId);

  const ending = checkEnding({
    currentDay: gameState.current_day,
    affection: gameState.affection,
    yukiAffection: gameState.yuki_affection,
    confessed: true,
  });

  if (!ending) {
    // Unreachable unless checkEnding's confession branch changes — better a
    // loud failure than silently leaving the game running after a confession.
    throw new Error('confession did not resolve to an ending');
  }

  await updateGameState(sessionId, {
    confessed: true,
    game_over: true,
    ending_id: ending,
  });

  return ending;
}

// Persists only. Scoring deliberately waits for endDay so the live segment
// clock never blocks on a Gemma round trip.
export async function recordEventResponse(eventLogId: string, playerAction: string): Promise<void> {
  await updateEventLogAction(eventLogId, playerAction);
}

// An events_log row names either a top-level event or a sub-event. Scoring
// needs both: the beat itself for its description/criteria, and its parent
// for affectedMeter — sub-events inherit their arc's target and never carry
// `affects` of their own.
interface BeatRef {
  beat: GameEvent | SubEvent;
  parent: GameEvent;
}

function findBeat(eventId: string, events: GameEvent[]): BeatRef | null {
  const topLevel = events.find((event) => event.id === eventId);
  if (topLevel) {
    // Re-randomised rather than recalled: events_log stores only the id, so the
    // exact detail the player saw isn't recoverable. Which cafe it was doesn't
    // affect how a response is graded — what matters is that no raw
    // "[activity]" placeholder is ever handed to the model.
    const filled = applyRandomizedDetails(topLevel);
    return { beat: filled, parent: filled };
  }

  for (const event of events) {
    const sub = (event.sub_events ?? []).find((candidate) => candidate.id === eventId);
    if (sub) {
      return { beat: sub, parent: event };
    }
  }

  return null;
}

// 'scoring' covers grading the day's event responses; the rest come from the
// batch eval itself. Semantic ids rather than display copy — the wording is
// the UI's business, not this module's.
export type EndDayStage = 'scoring' | BatchEvalStage;

export async function endDay(
  sessionId: string,
  onProgress?: (stage: EndDayStage) => void
): Promise<EndDayResult> {
  // Claimed before any work, because this function is expensive and NOT
  // idempotent: a second run scores the same day again, writes duplicate
  // knowledge chunks, and applies affection twice with no record of each run's
  // contribution — which is unrepairable, not merely untidy. A real
  // playthrough lost its save to exactly that.
  //
  // The claim is atomic in SQL rather than checked here; see
  // supabase/migrations/0002_end_of_day_claim.sql.
  const claimedDay = await claimDayForScoring(sessionId);
  if (claimedDay === null) {
    throw new Error('end of day is already running for this session');
  }

  try {
    return await scoreAndAdvanceDay(sessionId, onProgress);
  } catch (err) {
    // Released so a transient model failure stays retryable. End of day is
    // designed to be retried — a failed run leaves the day unadvanced — and a
    // claim held through the failure would strand the session for good.
    await releaseDayScoringClaim(sessionId);
    throw err;
  }
}

async function scoreAndAdvanceDay(
  sessionId: string,
  onProgress?: (stage: EndDayStage) => void
): Promise<EndDayResult> {
  const gameState = await getGameState(sessionId);
  const todaysLogs = await getEventLogsForDay(sessionId, gameState.current_day);

  const events = loadEvents();
  const arcIds = new Set(events.filter((event) => event.type === 'extended_event').map((event) => event.id));

  // Arc-start markers aren't beats the player was ever asked to answer, so
  // scoring them would charge a skip penalty for the arc merely beginning.
  const scorable = todaysLogs
    .filter((row) => !arcIds.has(row.event_id))
    .map((row) => ({ row, ref: findBeat(row.event_id, events) }))
    // An id with no match means events.json changed under an existing save.
    // Skipping is the safe read: better an unscored beat than a crash.
    .filter((entry): entry is { row: EventLog; ref: BeatRef } => entry.ref !== null);

  if (scorable.length > 0) {
    onProgress?.('scoring');
  }

  const scored = await Promise.all(
    scorable.map(async ({ row, ref }) => {
      const meter = affectedMeter(ref.parent);
      const currentAffection = meter === 'yuki' ? gameState.yuki_affection : gameState.affection;
      const playerAction = row.player_action?.trim();

      // No response goes to the deterministic penalty, never the LLM —
      // Gemma grades silence as a full `low`, which would conflate not
      // engaging with actively fumbling.
      const delta = playerAction
        ? (
            await withRetry(() =>
              generateEventOutcome({
                character: meter,
                eventDescription: ref.beat.description,
                actionPrompt: ref.beat.player_action_prompt,
                outcomes: ref.beat.affection_outcomes,
                playerAction,
                currentAffection,
                currentStage: affectionToStage(currentAffection),
              })
            )
          ).delta
        : skipPenalty(ref.beat);

      await updateEventLogOutcome(row.id, delta);
      return { ref, delta, meter, answered: Boolean(playerAction), playerAction: playerAction ?? '' };
    })
  );

  let eventAffectionDelta = 0;
  let eventYukiAffectionDelta = 0;
  let eventConcludedToday = false;
  let canonEventToday = false;
  const summaries: string[] = [];
  const actions: string[] = [];
  // Grouped by who was present, not by whose meter moved — Shiori's events
  // move Hiyori's meter but Shiori is the one who witnessed them.
  const eventContexts: Partial<Record<NPCCharacter, KnowledgeEventContext[]>> = {};

  for (const entry of scored) {
    if (entry.meter === 'yuki') {
      eventYukiAffectionDelta += entry.delta;
    } else {
      eventAffectionDelta += entry.delta;
    }

    if ('final_day' in entry.ref.beat && entry.ref.beat.final_day) {
      eventConcludedToday = true;
    }
    if (entry.ref.parent.type === 'canon_event') {
      canonEventToday = true;
    }
    if (entry.answered) {
      // Only answered beats feed the knowledge base. An ignored event is
      // something Adrian didn't engage with, so there's nothing for her to
      // have learned about him from it.
      const participant = eventParticipant(entry.ref.parent);
      (eventContexts[participant] ??= []).push({
        description: entry.ref.beat.description,
        playerAction: entry.playerAction,
      });

      // The diary is HIYORI's, so it only gets events she was actually part
      // of. Feeding it everything let Gemma fuse unrelated beats — a Shiori
      // conversation plus an umbrella shared with Hiyori came back as Adrian
      // sharing his umbrella with Shiori.
      if (participant === 'hiyori') {
        summaries.push(entry.ref.beat.description);
        actions.push(entry.playerAction);
      }
    }
  }

  // Event deltas go INTO the batch eval rather than being applied here, so
  // affection is written in exactly one place and the +/-15 diary threshold
  // sees total movement rather than the chat delta alone.
  const batch = await runEndOfDayBatchEval({
    sessionId,
    onProgress,
    eventAffectionDelta,
    eventYukiAffectionDelta,
    eventConcludedToday,
    canonEventToday,
    eventSummary: summaries.length > 0 ? summaries.join(' ') : undefined,
    adrianAction: actions.length > 0 ? actions.join(' ') : undefined,
    eventContexts,
  });

  // Checked against the post-batch numbers — an event or conversation today
  // may be exactly what pushed affection over an ending threshold.
  const ending = checkEnding({
    currentDay: gameState.current_day,
    affection: batch.newAffection,
    yukiAffection: batch.newYukiAffection,
    // Nothing sets this yet; a confession mechanic is still unbuilt, so in
    // practice only the day-30 endings can currently fire.
    confessed: gameState.confessed,
  });

  // The one place the day advances — batch-eval deliberately doesn't, since
  // it evaluates the day that happened rather than deciding the next one.
  if (ending) {
    await updateGameState(sessionId, { game_over: true, ending_id: ending });
  } else {
    await updateGameState(sessionId, { current_day: gameState.current_day + 1 });
  }

  return {
    newAffection: batch.newAffection,
    newYukiAffection: batch.newYukiAffection,
    newStage: batch.newStage,
    diaryGenerated: batch.diaryGenerated,
    eventAffectionDelta,
    eventYukiAffectionDelta,
    ending,
  };
}
