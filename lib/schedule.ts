// ============================================================
// lib/schedule.ts
//
// Generates one in-game day's schedule as 8 sequential segments
// covering a full 24-hour cycle (midnight to midnight): sleep_morning
// (the tail end of last night's sleep, i.e. midnight -> wake time),
// get_ready, morning_activity, lunch, activity_after_lunch, dinner,
// activity_after_dinner, sleep_night (closing the loop back to
// midnight).
//
// Each segment's duration is drawn from its own normal distribution,
// then the whole set is rescaled so the 8 durations sum to exactly
// 24 hours while preserving their relative proportions. The template
// means below already sum to 24 by construction, so the rescale
// factor stays close to 1 in practice rather than doing most of the
// work — only the day-to-day random variance needs correcting.
//
// sleep_night is deliberately short (~30min, mean 0.5h) — it's only
// the midnight-to-bedtime tail (e.g. staying up till 11:30pm), not
// the whole night's sleep. The bulk of sleep is sleep_morning, at the
// start of the *next* day's cycle.
//
// Deliberately NOT this module's job (deferred to later pieces):
// - Resolving what an 'activity' segment's category actually is
//   (class / homework / group project / free time / gaming) — for
//   now it's just a segment where a random event *could* fire and
//   the player can't chat, nothing more specific than that.
// - Converting free-time hours into an actual chat-time-budget number
//   (conversion rate still TBD, per README's Daily Flow note).
// - Actually firing random events during 'activity'/non-free segments.
//
// Days are independent of each other by design (no state carried
// across days, e.g. a late night doesn't push tomorrow's wake time
// later) — a known, deliberate simplification, not an oversight.
// ============================================================

export type ScheduleSegmentName =
  | 'sleep_morning'
  | 'get_ready'
  | 'morning_activity'
  | 'lunch'
  | 'activity_after_lunch'
  | 'dinner'
  | 'activity_after_dinner'
  | 'sleep_night';

export type ScheduleSegmentType = 'locked' | 'free' | 'activity';

export interface ScheduleSegment {
  name: ScheduleSegmentName;
  type: ScheduleSegmentType;
  startHour: number; // hours since midnight, e.g. 6.5 = 6:30am
  durationHours: number;
}

interface SegmentTemplate {
  name: ScheduleSegmentName;
  type: ScheduleSegmentType;
  mean: number;
  variance: number;
}

// Means sum to exactly 24 (6.5 + 2/3 + 4.3 + 1 + 86/15 + 1 + 4.3 + 0.5).
// morning_activity/activity_after_lunch/activity_after_dinner split the
// leftover time (after the fixed segments) in the original 3:4:3 ratio.
const SEGMENT_TEMPLATES: SegmentTemplate[] = [
  { name: 'sleep_morning', type: 'locked', mean: 6.5, variance: 0.5 },
  { name: 'get_ready', type: 'free', mean: 2 / 3, variance: 0.1 },
  { name: 'morning_activity', type: 'activity', mean: 4.3, variance: 1 },
  { name: 'lunch', type: 'free', mean: 1, variance: 0.25 },
  { name: 'activity_after_lunch', type: 'activity', mean: 86 / 15, variance: 1.5 },
  { name: 'dinner', type: 'free', mean: 1, variance: 0.25 },
  { name: 'activity_after_dinner', type: 'activity', mean: 4.3, variance: 1 },
  { name: 'sleep_night', type: 'locked', mean: 0.5, variance: 0.1 },
];

// Box-Muller transform — Math.random() is only uniform, this turns two
// uniform samples into one standard-normal sample, then scales it to
// the target mean/variance.
function sampleNormal(mean: number, variance: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * Math.sqrt(variance);
}

export function generateDailySchedule(): ScheduleSegment[] {
  // Clamped to a small positive floor — raw Gaussian draws can go
  // negative, especially for small-mean/high-variance segments.
  const rawDurations = SEGMENT_TEMPLATES.map((segment) =>
    Math.max(sampleNormal(segment.mean, segment.variance), 0.1)
  );

  const total = rawDurations.reduce((sum, duration) => sum + duration, 0);
  const scale = 24 / total;

  let startHour = 0;
  return SEGMENT_TEMPLATES.map((segment, i) => {
    const durationHours = rawDurations[i] * scale;
    const result: ScheduleSegment = {
      name: segment.name,
      type: segment.type,
      startHour,
      durationHours,
    };
    startHour += durationHours;
    return result;
  });
}
