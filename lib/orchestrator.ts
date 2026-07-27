// ============================================================
// lib/orchestrator.ts
//
// The game loop — the only module that knows how a day actually runs.
// Everything else is deliberately unaware of the others: lib/events.ts
// is pure logic with no DB access, lib/chat.ts handles one message,
// lib/batch-eval.ts handles one end-of-day. This ties them together.
//
// Three entry points, matching what a frontend needs:
//   startDay()            -> the day's plan (schedule + what fires when)
//   recordEventResponse() -> the player's free text for one event
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
  updateGameState,
  getAllEventLogs,
  getEventLogsForDay,
  insertEventLog,
  updateEventLogAction,
  updateEventLogOutcome,
} from './supabase.js';
import type { EventLog } from './supabase.js';
import {
  loadEvents,
  checkExtendedEventTrigger,
  resolveActivitySegment,
  resolveActivitySegmentDuringArc,
  affectedMeter,
  skipPenalty,
} from './events.js';
import type {
  ActiveExtendedEvent,
  ActivitySegmentName,
  GameEvent,
  SubEvent,
  FlavorActivity,
} from './events.js';
import { generateDailySchedule } from './schedule.js';
import type { ScheduleSegment } from './schedule.js';
import { generateEventOutcome } from './gemma.js';
import { runEndOfDayBatchEval, withRetry } from './batch-eval.js';
import { checkEnding } from './endings.js';
import type { EndingId } from './endings.js';
import { affectionToStage, type RelationshipStage } from './relationship.js';

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

// HINT: rough sequence —
//
// 1. getGameState(sessionId) + getAllEventLogs(sessionId), then
//    reconstructArcState(logs, gameState.current_day) above.
//
// 2. If arcState.activeArc is null, call checkExtendedEventTrigger with
//    the game state's stage/affection/yukiAffection and
//    arcState.usedExtendedEventIds. If it returns an arc, that arc starts
//    TODAY: insertEventLog a row for it (event_id: arc.id, day_triggered:
//    current_day, player_action: null, affection_delta: 0) and build an
//    ActiveExtendedEvent for it with startDay = current_day and an empty
//    firedSubEventIds. Note the arc's own row is a marker that the arc
//    began — it isn't a beat the player responds to, so it stays
//    unanswered forever and must be excluded from scoring in endDay.
//
// 3. generateDailySchedule() for the day's 8 segments.
//
// 4. For each of ACTIVITY_SEGMENTS in order: if an arc is active call
//    resolveActivitySegmentDuringArc, else resolveActivitySegment. Feed
//    each fired sub-event's id back into the ActiveExtendedEvent's
//    firedSubEventIds as you go — otherwise the force-out and final-day
//    checks can fire the same beat three times in one day.
//
// 5. Every fired event/sub-event gets an insertEventLog row with
//    player_action null. It returns the inserted row, so use its .id as
//    the ResolvedSegment's eventLogId — that's the handle the client
//    passes back to recordEventResponse.
//
// 6. Return the DayPlan.
// The stage is derived from affection rather than read off
// game_state.relationship_stage: that column is plain text with no
// constraint and is denormalized anyway, so deriving it is both correctly
// typed and immune to drift. See lib/supabase.ts's GameState.
export async function startDay(sessionId: string): Promise<DayPlan> {
  const gameState = await getGameState(sessionId);
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

  for (const segment of ACTIVITY_SEGMENTS) {
    const gates = {
      segment,
      currentStage,
      affection: gameState.affection,
      yukiAffection: gameState.yuki_affection,
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
    return { beat: topLevel, parent: topLevel };
  }

  for (const event of events) {
    const sub = (event.sub_events ?? []).find((candidate) => candidate.id === eventId);
    if (sub) {
      return { beat: sub, parent: event };
    }
  }

  return null;
}

export async function endDay(sessionId: string): Promise<EndDayResult> {
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
      return { ref, delta, meter, answered: Boolean(playerAction) };
    })
  );

  let eventAffectionDelta = 0;
  let eventYukiAffectionDelta = 0;
  let eventConcludedToday = false;
  let canonEventToday = false;
  const summaries: string[] = [];
  const actions: string[] = [];

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
      summaries.push(entry.ref.beat.description);
    }
  }

  for (const { row } of scorable) {
    const action = row.player_action?.trim();
    if (action) actions.push(action);
  }

  // Event deltas go INTO the batch eval rather than being applied here, so
  // affection is written in exactly one place and the +/-15 diary threshold
  // sees total movement rather than the chat delta alone.
  const batch = await runEndOfDayBatchEval({
    sessionId,
    eventAffectionDelta,
    eventYukiAffectionDelta,
    eventConcludedToday,
    canonEventToday,
    eventSummary: summaries.length > 0 ? summaries.join(' ') : undefined,
    adrianAction: actions.length > 0 ? actions.join(' ') : undefined,
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
