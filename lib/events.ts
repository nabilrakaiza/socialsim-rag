// ============================================================
// lib/events.ts
//
// Loads and resolves lore/events.json — the random event system.
// This file covers steps 1-2 of the plan: loading/typing the data,
// and resolving what happens during ONE activity segment on a normal
// day (no active extended event). Extended-event triggering and
// in-arc resolution (steps 3-4) come later, once this is working.
//
// stage_required in the JSON is lowercase ('stranger', 'acquaintance',
// 'friend') — NOT the same casing as lib/relationship.ts's
// RelationshipStage ('Stranger', 'Acquaintance', ...). These need an
// explicit mapping/comparison, not a direct string match.
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import type { RelationshipStage } from './relationship.js';

const EVENTS_PATH = join(process.cwd(), 'lore', 'events.json');

export type ActivitySegmentName = 'morning_activity' | 'activity_after_lunch' | 'activity_after_dinner';

export type EventStage = 'stranger' | 'acquaintance' | 'friend' | 'close_friend';

export interface AffectionOutcomes {
  high: string;
  mid: string;
  low: string;
}

export interface SubEvent {
  id: string;
  day_offset: string;
  description: string;
  player_action_prompt: string;
  affection_outcomes: AffectionOutcomes;
  eligible_segments: ActivitySegmentName[];
  final_day?: boolean;
  // Ambient beats span the whole arc and are written to survive repeating —
  // they exist so an active arc actually fills its days instead of leaving
  // most segments to unrelated random events. The narrative one-offs are
  // the ones without this flag.
  ambient?: boolean;
}

export interface GameEvent {
  id: string;
  title: string;
  description: string;
  stage_required: EventStage;
  affection_required: number;
  yuki_affection_required?: number;
  type: 'real_life_event' | 'extended_event' | 'canon_event' | 'secret_end_event';
  // Which meter this event's affection_outcomes score against. Absent means
  // Hiyori — only the four Yuki-route events set it. Sub-events inherit from
  // their parent arc. Shiori-focused events deliberately leave this unset and
  // score against Hiyori: she has no meter and isn't a route, but she's
  // protective of Hiyori, so how Adrian treats her reaches Hiyori indirectly.
  affects?: 'hiyori' | 'yuki';
  duration_days: number;
  randomized_details?: Record<string, string[]>;
  player_action_prompt: string;
  affection_outcomes: AffectionOutcomes;
  notes?: string;
  eligible_segments?: ActivitySegmentName[];
  sub_events?: SubEvent[];
}

interface EventsFile {
  events: GameEvent[];
  endings: unknown[];
}

// Ordinal ranking so "does the player's current stage meet the
// requirement" can be a >= comparison instead of a string match.
const STAGE_ORDER: Record<EventStage, number> = {
  stranger: 0,
  acquaintance: 1,
  friend: 2,
  close_friend: 3,
};

// Maps RelationshipStage's format ('Close Friend') to EventStage's
// format ('close_friend') — lowercased, space replaced with underscore.
function toEventStage(stage: RelationshipStage): EventStage {
  return stage.toLowerCase().replace(' ', '_') as EventStage;
}

// The progress gates every event shares regardless of type. Both the
// normal-day and extended-event paths need exactly these three checks,
// so they live here rather than being duplicated in each filter.
interface GateInput {
  currentStage: RelationshipStage;
  affection: number;
  yukiAffection: number;
}

function meetsGates(event: GameEvent, input: GateInput): boolean {
  if (STAGE_ORDER[event.stage_required] > STAGE_ORDER[toEventStage(input.currentStage)]) {
    return false;
  }
  if (input.affection < event.affection_required) {
    return false;
  }
  // Only yuki_econs_crunch sets this — an arc gated on Yuki's own meter
  // instead of the main Hiyori one, matching her route's separate design.
  if (event.yuki_affection_required !== undefined && input.yukiAffection < event.yuki_affection_required) {
    return false;
  }
  return true;
}

// Flavor-only outcomes for a normal (non-event) activity-segment roll —
// no event fires, nothing happens mechanically. Kept here as code, not
// in events.json, since it's a game-design constant, not lore content
// (same reasoning as lib/schedule.ts's SEGMENT_TEMPLATES).
export type FlavorActivity = string;

interface SegmentOutcomeProbabilities {
  eventChance: number; // 0-1
  flavorOptions: FlavorActivity[]; // chosen uniformly if event doesn't fire
}

// Only eventChance is a real probability (rolled against); flavorOptions
// are picked uniformly among themselves when the roll misses — their
// relative weights don't matter since none of them affect game state,
// they're flavor text only.
const SEGMENT_PROBABILITIES: Record<ActivitySegmentName, SegmentOutcomeProbabilities> = {
  morning_activity: {
    eventChance: 0.7,
    flavorOptions: ['class', 'tutorial/lab session', 'working on a project', 'catching up on homework', 'gym / morning workout'],
  },
  activity_after_lunch: {
    eventChance: 0.7,
    flavorOptions: ['class', 'CCA activities', 'sport', 'part-time job / internship shift', 'napping / chilling at the hall'],
  },
  activity_after_dinner: {
    eventChance: 0.5,
    flavorOptions: ['working on a project', 'homework', 'gaming with friends', 'late-night talk with friends', 'watching a show/movie alone'],
  },
};

// HINT: readFileSync(EVENTS_PATH, 'utf-8') -> JSON.parse -> cast to
// EventsFile -> return .events. Called fresh each time rather than
// cached at module load — events.json changes during development and
// scripts re-run often; caching would need a restart to pick up edits.
export function loadEvents(): GameEvent[] {
  const rawText = readFileSync(EVENTS_PATH, 'utf-8');
  const parsed: EventsFile = JSON.parse(rawText);

  return parsed.events;
}

// Resolving the default here rather than at each call site, so a missing
// `affects` can't be misread as "this event moves no meter at all".
export function affectedMeter(event: GameEvent): 'hiyori' | 'yuki' {
  return event.affects ?? 'hiyori';
}

export interface SegmentResolutionInput {
  segment: ActivitySegmentName;
  currentStage: RelationshipStage;
  affection: number;
  yukiAffection: number;
}

export type SegmentResolutionResult =
  | { firedEvent: false; flavor: FlavorActivity }
  | { firedEvent: true; event: GameEvent };

// ============================================================
// Extended events (steps 3-4).
//
// State lives in the `events_log` table, not a new one — a row per
// fired event/sub-event (event_id + day_triggered) is enough to
// reconstruct everything below, so no schema change is needed.
//
// No blanket force-out for extended events themselves: the 13 arcs
// total 49 days of content against a 30-day game running one arc at a
// time, so guaranteeing them all is impossible by construction. Which
// arcs a playthrough sees is meant to vary. Sub-event force-out WITHIN
// an active arc still applies.
// ============================================================

export const TOTAL_GAME_DAYS = 30;

// Chance an idle day starts a new arc. ~4 idle days per trigger plus
// ~3.7 avg arc length works out to roughly 3-4 arcs per playthrough.
export const EXTENDED_EVENT_DAILY_CHANCE = 0.25;

// During an active arc, share of firing segments that go to that arc's
// sub-events rather than the normal event/flavor pool.
export const SUB_EVENT_SHARE = 2 / 3;

export interface ActiveExtendedEvent {
  event: GameEvent;
  startDay: number; // in-game day the arc began (day 1 of the arc)
  firedSubEventIds: string[]; // sub-events that have fired at least once
}

// HINT: day_offset is a string, either a single day ("6") or an
// inclusive range ("3-4"), relative to the arc's own start (1-indexed:
// "1" is the arc's first day). Return { first, last } — for a single
// day both are the same number. String.split('-') + Number() is enough;
// no regex needed.
function parseDayOffset(dayOffset: string): { first: number; last: number } {
  const day = dayOffset.split("-")
  const first = parseInt(day[0])
  const last = parseInt(day[day.length - 1])

  return { first, last };
}

export interface ExtendedEventTriggerInput {
  currentDay: number;
  currentStage: RelationshipStage;
  affection: number;
  yukiAffection: number;
  usedExtendedEventIds: string[]; // arcs already run this playthrough (one-time-only)
}

// Called once at the start of a day, and only when no arc is currently
// active — the caller owns that check, since it's the one tracking the
// active arc's state.
export function checkExtendedEventTrigger(input: ExtendedEventTriggerInput): GameEvent | null {
  const eligibleArcs = loadEvents().filter((event) => {
    if (event.type !== 'extended_event') {
      return false;
    }
    // one-time-only per playthrough
    if (input.usedExtendedEventIds.includes(event.id)) {
      return false;
    }
    // the arc would run duration_days starting today, so it has to fit
    // inside the game — no starting a 7-day arc on day 26
    if (input.currentDay + event.duration_days - 1 > TOTAL_GAME_DAYS) {
      return false;
    }
    return meetsGates(event, input);
  });

  if (eligibleArcs.length === 0) {
    return null;
  }

  if (Math.random() >= EXTENDED_EVENT_DAILY_CHANCE) {
    return null;
  }

  return eligibleArcs[Math.floor(Math.random() * eligibleArcs.length)];
}

export interface ArcSegmentResolutionInput extends SegmentResolutionInput {
  currentDay: number;
  activeEvent: ActiveExtendedEvent;
}

export type ArcSegmentResolutionResult =
  | SegmentResolutionResult
  | { firedEvent: true; event: GameEvent; subEvent: SubEvent };

// Resolves one activity segment while an arc is active. Regular events
// still fire during an arc — it just weights the odds toward the arc's
// own sub-events rather than taking the day over completely.
//
// Note `firedSubEventIds` is only consulted for the two guarantee paths
// (final-day, force-out): sub-events are allowed to repeat, so having
// fired once doesn't remove one from the normal roll.
export function resolveActivitySegmentDuringArc(input: ArcSegmentResolutionInput): ArcSegmentResolutionResult {
  const { activeEvent } = input;
  const arc = activeEvent.event;
  const subEvents = arc.sub_events ?? [];

  // 1-indexed so it lines up with day_offset's values directly.
  const dayInArc = input.currentDay - activeEvent.startDay + 1;

  // A final-day beat (presentation day, post-show, ...) is guaranteed, not
  // rolled — the first eligible segment of the arc's last day takes it.
  if (dayInArc === arc.duration_days) {
    const finale = subEvents.find(
      (sub) =>
        sub.final_day === true &&
        !activeEvent.firedSubEventIds.includes(sub.id) &&
        sub.eligible_segments.includes(input.segment)
    );
    if (finale) {
      return { firedEvent: true, event: arc, subEvent: finale };
    }
  }

  const eligibleNow = subEvents
    .filter((sub) => !sub.final_day && sub.eligible_segments.includes(input.segment))
    .map((sub) => ({ sub, window: parseDayOffset(sub.day_offset) }))
    .filter(({ window }) => dayInArc >= window.first && dayInArc <= window.last);

  // Force-out: this is the last day of its window and it still hasn't
  // happened, so stop rolling and just fire it.
  const owed = eligibleNow.find(
    ({ sub, window }) => window.last === dayInArc && !activeEvent.firedSubEventIds.includes(sub.id)
  );
  if (owed) {
    return { firedEvent: true, event: arc, subEvent: owed.sub };
  }

  if (eligibleNow.length > 0 && Math.random() < SUB_EVENT_SHARE) {
    const picked = eligibleNow[Math.floor(Math.random() * eligibleNow.length)];
    return { firedEvent: true, event: arc, subEvent: picked.sub };
  }

  // Roll missed, or the arc had nothing eligible for this segment today.
  return resolveActivitySegment(input);
}

// HINT: rough sequence —
//
// 1. Roll against SEGMENT_PROBABILITIES[input.segment].eventChance
//    (Math.random() < eventChance). If it misses, pick a random entry
//    from .flavorOptions and return { firedEvent: false, flavor }.
//
// 2. If it hits, filter loadEvents() down to events that are eligible:
//    - type === 'real_life_event' or 'canon_event' or 'secret_end_event'
//      (NOT 'extended_event' — those are step 3/4's job, this function
//      is for normal days only)
//    - event.eligible_segments?.includes(input.segment)
//    - STAGE_ORDER[event.stage_required] <= STAGE_ORDER[toEventStage(input.currentStage)]
//    - input.affection >= event.affection_required
//    - if event.yuki_affection_required is set, input.yukiAffection
//      must also meet it (see yuki_econs_crunch — the one event
//      gated on Yuki's meter instead of/alongside the main one)
//
// 3. Pick one uniformly at random from the eligible list. If the list
//    is empty (can happen early game when almost nothing's unlocked
//    yet), fall back to a flavor result instead of throwing — a "roll
//    said event, but nothing's actually eligible yet" case shouldn't
//    crash the day.
//
// 4. Return { firedEvent: true, event }.
export function resolveActivitySegment(input: SegmentResolutionInput): SegmentResolutionResult {
  const { eventChance, flavorOptions } = SEGMENT_PROBABILITIES[input.segment];

  if (Math.random() >= eventChance) {
    const flavor = flavorOptions[Math.floor(Math.random() * flavorOptions.length)];
    return { firedEvent: false, flavor };
  }

  const eligibleEvents = loadEvents().filter((event) => {
    if (event.type !== 'real_life_event' && event.type !== 'canon_event' && event.type !== 'secret_end_event') {
      return false;
    }
    if (!event.eligible_segments?.includes(input.segment)) {
      return false;
    }
    return meetsGates(event, input);
  });

  if (eligibleEvents.length === 0) {
    const flavor = flavorOptions[Math.floor(Math.random() * flavorOptions.length)];
    return { firedEvent: false, flavor };
  }

  const event = eligibleEvents[Math.floor(Math.random() * eligibleEvents.length)];
  return { firedEvent: true, event };
}
