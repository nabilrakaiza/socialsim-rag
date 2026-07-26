// Simulates complete extended-event arcs to verify resolveActivitySegmentDuringArc:
// every sub-event must land at least once (force-out + final-day guarantee),
// final-day beats must only fire on the arc's last day, and regular events
// must still break through at roughly the intended rate.

import {
  loadEvents,
  resolveActivitySegmentDuringArc,
  SUB_EVENT_SHARE,
  type ActiveExtendedEvent,
  type ActivitySegmentName,
} from '../lib/events.js';

const SEGMENTS: ActivitySegmentName[] = ['morning_activity', 'activity_after_lunch', 'activity_after_dinner'];

interface SimResult {
  firedSubEvents: { dayInArc: number; segment: ActivitySegmentName; id: string }[];
  regularEventIds: string[];
  flavorCount: number;
}

function simulateArc(arcId: string, startDay: number): SimResult {
  const arc = loadEvents().find((e) => e.id === arcId)!;
  const active: ActiveExtendedEvent = { event: arc, startDay, firedSubEventIds: [] };
  const out: SimResult = { firedSubEvents: [], regularEventIds: [], flavorCount: 0 };

  for (let day = startDay; day <= startDay + arc.duration_days - 1; day++) {
    for (const segment of SEGMENTS) {
      const result = resolveActivitySegmentDuringArc({
        segment,
        currentDay: day,
        activeEvent: active,
        currentStage: 'Friend',
        affection: 60,
        yukiAffection: 60,
      });

      if (result.firedEvent && 'subEvent' in result) {
        out.firedSubEvents.push({ dayInArc: day - startDay + 1, segment, id: result.subEvent.id });
        // the caller owns this bookkeeping — mirrors what the orchestrator will do
        if (!active.firedSubEventIds.includes(result.subEvent.id)) {
          active.firedSubEventIds.push(result.subEvent.id);
        }
      } else if (result.firedEvent) {
        out.regularEventIds.push(result.event.id);
      } else {
        out.flavorCount++;
      }
    }
  }
  return out;
}

const RUNS = 500;
// every extended event, not a sample — a guarantee that only holds for some
// arcs isn't a guarantee, and the arc-specific failure mode this caught
// (final-day beat preempting a single-segment ambient's last force-out)
// depends entirely on each arc's own segment layout.
const arcsToTest = loadEvents().filter((e) => e.type === 'extended_event').map((e) => e.id);

for (const arcId of arcsToTest) {
  const arc = loadEvents().find((e) => e.id === arcId)!;
  const subIds = (arc.sub_events ?? []).map((s) => s.id);
  const finalDayIds = (arc.sub_events ?? []).filter((s) => s.final_day).map((s) => s.id);

  let runsMissingASubEvent = 0;
  let finalDayFiredOffFinalDay = 0;
  let totalSubFires = 0;
  let totalRegularFires = 0;
  let totalFlavor = 0;

  for (let i = 0; i < RUNS; i++) {
    const sim = simulateArc(arcId, 1);
    const seen = new Set(sim.firedSubEvents.map((f) => f.id));
    if (subIds.some((id) => !seen.has(id))) runsMissingASubEvent++;

    for (const f of sim.firedSubEvents) {
      if (finalDayIds.includes(f.id) && f.dayInArc !== arc.duration_days) finalDayFiredOffFinalDay++;
    }
    totalSubFires += sim.firedSubEvents.length;
    totalRegularFires += sim.regularEventIds.length;
    totalFlavor += sim.flavorCount;
  }

  const firingSegments = totalSubFires + totalRegularFires;
  console.log(`\n=== ${arcId} (${arc.duration_days}d, ${subIds.length} sub-events, ${finalDayIds.length} final-day) ===`);
  console.log(`runs where a sub-event never fired: ${runsMissingASubEvent}/${RUNS} (expected 0)`);
  console.log(`final-day beat fired off the final day: ${finalDayFiredOffFinalDay} (expected 0)`);
  // Runs above SUB_EVENT_SHARE on purpose: the 2/3 roll is only one of three
  // ways a sub-event lands (force-out and the final-day guarantee bypass it),
  // and when the roll misses, the normal path still resolves to flavor-only
  // about a third of the time — which isn't a "firing segment" at all.
  console.log(
    `sub-event share of firing segments: ${((totalSubFires / firingSegments) * 100).toFixed(1)}% ` +
    `(roll weight is ${(SUB_EVENT_SHARE * 100).toFixed(0)}%; see note above)`
  );
  console.log(`regular events still broke through: ${totalRegularFires > 0} (${(totalRegularFires / RUNS).toFixed(1)}/run)`);
}

// Spot-check one concrete run so the day-by-day shape is visible.
console.log('\n\n=== sample single run: group_project_week ===');
const sample = simulateArc('group_project_week', 1);
for (const f of sample.firedSubEvents) {
  console.log(`  day ${f.dayInArc} ${f.segment.padEnd(21)} -> ${f.id}`);
}
console.log(`  (plus ${sample.regularEventIds.length} regular events, ${sample.flavorCount} flavor-only segments)`);
