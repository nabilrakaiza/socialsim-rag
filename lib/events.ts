// ============================================================
// lib/events.ts
//
// Loads and resolves lore/events.json — the random event system.
// Covers normal-day segment resolution, extended-event triggering,
// and in-arc sub-event resolution. Pure logic: reads no database and
// writes none. Persisting fired events to events_log and rebuilding
// active-arc state from those rows belongs to the orchestrator.
//
// stage_required in the JSON is lowercase ('stranger', 'acquaintance',
// 'friend') — NOT the same casing as lib/relationship.ts's
// RelationshipStage ('Stranger', 'Acquaintance', ...). These need an
// explicit mapping/comparison, not a direct string match.
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import type { RelationshipStage } from './relationship';
import { TOTAL_GAME_DAYS } from './endings';

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
  // Who actually witnessed this, for the end-of-day knowledge update. Distinct
  // from `affects`, which is about whose meter moves: Shiori's events move
  // Hiyori's meter (she's protective and reports back) but SHIORI is the one
  // who saw what Adrian did. Attributing them to Hiyori would break the
  // siloed-knowledge rule. Absent means it matches `affects`, which is correct
  // for every Hiyori and Yuki event.
  participant?: 'hiyori' | 'shiori' | 'yuki';
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

// An events_log row names either a top-level event or a sub-event. Callers
// need both: the beat itself for its description/criteria, and its parent for
// affectedMeter and eventParticipant — sub-events inherit their arc's target
// and never carry `affects` of their own.
export interface BeatRef {
  beat: GameEvent | SubEvent;
  parent: GameEvent;
}

// `seed` should be detailSeed() for the row's own session and day, so the
// randomized details come back as the player saw them. Either way no raw
// "[activity]" placeholder is ever handed on.
export function findBeat(eventId: string, events: GameEvent[], seed?: string): BeatRef | null {
  const topLevel = events.find((event) => event.id === eventId);
  if (topLevel) {
    const filled = applyRandomizedDetails(topLevel, seed);
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

// Read fresh each call rather than cached at module load — events.json
// changes during development and scripts re-run often, so caching would
// mean restarting to pick up edits.
export function loadEvents(): GameEvent[] {
  const rawText = readFileSync(EVENTS_PATH, 'utf-8');
  const parsed: EventsFile = JSON.parse(rawText);

  return parsed.events;
}

// Skipping an event isn't the same as handling one badly — it's passive,
// so it costs less than the -15..-2 a genuinely poor response can. But it
// isn't free either: ignoring something is still a choice the characters
// would notice. Scaled by how much the beat mattered, which the data
// already tells us: an ambient beat repeats and missing one barely
// registers, while a final-day beat is the moment the whole arc built to.
//
// Applied by the orchestrator INSTEAD of calling generateEventOutcome when
// no player_action was recorded — an unanswered event should never reach
// the LLM, which would grade the silence as a poor response and charge the
// full penalty.
export const SKIP_PENALTIES = {
  ambient: -1,
  standard: -3,
  finalDay: -5,
} as const;

export function skipPenalty(beat: GameEvent | SubEvent): number {
  if ('final_day' in beat && beat.final_day) {
    return SKIP_PENALTIES.finalDay;
  }
  if ('ambient' in beat && beat.ambient) {
    return SKIP_PENALTIES.ambient;
  }
  return SKIP_PENALTIES.standard;
}

// Resolving the default here rather than at each call site, so a missing
// `affects` can't be misread as "this event moves no meter at all".
export function affectedMeter(event: GameEvent): 'hiyori' | 'yuki' {
  return event.affects ?? 'hiyori';
}

// Whose knowledge base this event should update. Falls back to the meter,
// which is right everywhere except Shiori's events — see `participant`.
export function eventParticipant(event: GameEvent): 'hiyori' | 'shiori' | 'yuki' {
  return event.participant ?? affectedMeter(event);
}

// FNV-1a. Small, dependency-free, and the same on every run and machine —
// which is the only property a detail seed needs.
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// The seed for one day's randomized details. Session and day are enough: a
// regular event can't fire twice in a day, so (session, day, event id) names
// exactly one firing — and all three are on the events_log row, so nothing
// extra has to be stored to get the same fill back.
export function detailSeed(sessionId: string, day: number): string {
  return `${sessionId}:${day}`;
}

// Some events carry `[placeholder]` slots in their text with the candidate
// fills in `randomized_details` — `[activity]` draws from `activity_options`,
// `[Location]` from `location_options`. Nothing was substituting them, so the
// raw bracket text reached the player ("...while [activity]").
//
// Returns a copy rather than mutating: loadEvents() re-reads the file each
// call, but mutating shared objects would still be a trap for any caller that
// holds one across fires.
//
// With a `seed` the picks are repeatable. events_log stores only an event's id,
// so anything that looks a beat up again later — end-of-day scoring, the chat
// prompt's "earlier today" block — has to re-derive which bus stop it was.
// Unseeded, that second look rolled a fresh one, and a character could recall
// the 7-Eleven when the player had been shown the MRT. Pass detailSeed() and
// every lookup of the same event on the same day lands on the same fill.
//
// Each slot is chosen once per call, not once per occurrence, so a title and a
// description that share `[Location]` can't disagree with each other.
export function applyRandomizedDetails(event: GameEvent, seed?: string): GameEvent {
  const details = event.randomized_details;
  if (!details) return event;

  const chosen = new Map<string, string>();
  const fill = (text: string): string =>
    text.replace(/\[([^\]]+)\]/g, (whole, key: string) => {
      const slot = key.toLowerCase();
      const options = details[`${slot}_options`];
      if (!options || options.length === 0) return whole;
      if (!chosen.has(slot)) {
        const index = seed === undefined
          ? Math.floor(Math.random() * options.length)
          : hashString(`${seed}:${event.id}:${slot}`) % options.length;
        chosen.set(slot, options[index]);
      }
      return chosen.get(slot)!;
    });

  return {
    ...event,
    title: fill(event.title),
    description: fill(event.description),
    player_action_prompt: fill(event.player_action_prompt),
  };
}

export interface SegmentResolutionInput {
  segment: ActivitySegmentName;
  currentStage: RelationshipStage;
  affection: number;
  yukiAffection: number;
  // Regular events already fired today, excluded from the pool. Each segment
  // otherwise rolls independently, so the same event could fire twice in one
  // day — early game especially, where only a handful are unlocked and
  // "you accidentally called her" landing twice in an afternoon reads as a bug.
  //
  // Sub-events are deliberately NOT filtered this way: ambient beats are
  // written to repeat across an arc, which is the whole reason they exist.
  firedTodayIds: string[];
  // How many times each regular event has fired so far this playthrough, by
  // id. Missing means never. Drives repeatWeight below.
  firedCounts: Record<string, number>;
  // detailSeed() for the day being resolved. Optional so scripts that only
  // care which event fires can leave the fill random.
  detailSeed?: string;
}

// How much less likely an event becomes each time it has already fired:
// weight = 1 / (1 + timesFired) ^ exponent. At 2, an event seen once is a
// quarter as likely as an unseen one, seen twice a ninth.
//
// The pick used to be uniform with no memory past the current day, so the same
// event could land three days running while others in the pool had never
// fired. Weighting spends the unseen ones first.
//
// It evens repeats out; it cannot remove them. Once everything eligible has
// fired equally often the weights are level again — at Stranger only four
// events are eligible at all, and no weighting makes four events feel like
// thirty days of content. That needs more events, not a different exponent.
export const REPEAT_WEIGHT_EXPONENT = 2;

export function repeatWeight(timesFired: number): number {
  return 1 / (1 + timesFired) ** REPEAT_WEIGHT_EXPONENT;
}

function pickWeighted<T>(items: T[], weightOf: (item: T) => number): T {
  const weights = items.map(weightOf);
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll < 0) return items[i];
  }
  // Only reachable through float rounding on the last subtraction.
  return items[items.length - 1];
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

// Re-exported so callers of this module don't need to know the game's
// length lives in endings.ts — that module owns "when does the game end".
export { TOTAL_GAME_DAYS } from './endings';

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

// day_offset is either a single day ("6") or an inclusive range ("3-4"),
// 1-indexed against the arc's own start. A single day yields the same
// value for both ends.
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

// Spelled out rather than `SegmentResolutionResult | {...subEvent}`, so the
// union is properly discriminated. With the fired-without-sub member simply
// lacking `subEvent`, callers had to write `'subEvent' in result` — and since
// TS 4.9 that narrowing does NOT exclude members without the property, it
// intersects them with Record<'subEvent', unknown>, so `result.subEvent` came
// back as `unknown`. Declaring `subEvent?: undefined` makes it plain
// `SubEvent | undefined`, readable directly with no `in` check and no cast.
export type ArcSegmentResolutionResult =
  | { firedEvent: false; flavor: FlavorActivity }
  | { firedEvent: true; event: GameEvent; subEvent?: undefined }
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

// Resolves one activity segment on a normal day — no arc running. An
// empty eligible pool (early game, before much is unlocked) falls back to
// flavor rather than forcing an event that isn't available yet.
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
    if (input.firedTodayIds.includes(event.id)) {
      return false;
    }
    return meetsGates(event, input);
  });

  if (eligibleEvents.length === 0) {
    const flavor = flavorOptions[Math.floor(Math.random() * flavorOptions.length)];
    return { firedEvent: false, flavor };
  }

  const event = pickWeighted(eligibleEvents, (candidate) => repeatWeight(input.firedCounts[candidate.id] ?? 0));
  return { firedEvent: true, event: applyRandomizedDetails(event, input.detailSeed) };
}
