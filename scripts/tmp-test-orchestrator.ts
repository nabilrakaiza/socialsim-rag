// Checks reconstructArcState — the piece that rebuilds all extended-event
// state from events_log rows, which is why the event system needed no
// schema change. Pure given the rows, so no DB or API calls here.

// Needed even though this test makes no DB calls: importing the orchestrator
// pulls in lib/supabase.ts, which constructs its client at module load.
import 'dotenv/config';

import { reconstructArcState } from '../lib/orchestrator.js';
import type { EventLog } from '../lib/supabase.js';
import { loadEvents } from '../lib/events.js';

let seq = 0;
function log(event_id: string, day_triggered: number): EventLog {
  return {
    id: `row-${seq++}`,
    session_id: 's',
    event_id,
    day_triggered,
    player_action: null,
    affection_delta: 0,
    created_at: new Date().toISOString(),
  };
}

const events = loadEvents();
const groupProject = events.find((e) => e.id === 'group_project_week')!; // 6 days
const orientation = events.find((e) => e.id === 'orientation_committee')!; // 7 days

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       got ${JSON.stringify(actual)}\n       want ${JSON.stringify(expected)}`);
  return ok;
}

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  if (!check(label, actual, expected)) failures++;
}

// --- no history at all ---
let s = reconstructArcState([], 1);
expect('empty log -> no used arcs', s.usedExtendedEventIds, []);
expect('empty log -> no active arc', s.activeArc, null);

// --- an arc started today ---
s = reconstructArcState([log('group_project_week', 5)], 5);
expect('arc started today is used', s.usedExtendedEventIds, ['group_project_week']);
expect('arc started today is active', s.activeArc?.event.id, 'group_project_week');
expect('  startDay recorded', s.activeArc?.startDay, 5);
expect('  no sub-events yet', s.activeArc?.firedSubEventIds, []);

// --- mid-arc, with sub-events fired ---
s = reconstructArcState(
  [log('group_project_week', 5), log('group_project_work_block', 5), log('group_project_evening_grind', 6)],
  7
);
expect('mid-arc still active on day 7 (5..10)', s.activeArc?.event.id, 'group_project_week');
expect('  fired sub-events collected', s.activeArc?.firedSubEventIds, [
  'group_project_work_block',
  'group_project_evening_grind',
]);
expect('  sub-event rows are not counted as used arcs', s.usedExtendedEventIds, ['group_project_week']);

// --- last day of the arc is still active (start + duration - 1) ---
s = reconstructArcState([log('group_project_week', 5)], 5 + groupProject.duration_days - 1);
expect(`final day (${5 + groupProject.duration_days - 1}) still active`, s.activeArc?.event.id, 'group_project_week');

// --- the day after it ends ---
s = reconstructArcState([log('group_project_week', 5)], 5 + groupProject.duration_days);
expect('day after the arc ends -> not active', s.activeArc, null);
expect('  but still counted as used', s.usedExtendedEventIds, ['group_project_week']);

// --- a finished arc plus a current one ---
s = reconstructArcState(
  [log('orientation_committee', 1), log('orientation_committee_work_session', 2), log('group_project_week', 12)],
  13
);
expect('both arcs counted as used', s.usedExtendedEventIds, ['orientation_committee', 'group_project_week']);
expect('only the current one is active', s.activeArc?.event.id, 'group_project_week');
expect("  previous arc's sub-events excluded", s.activeArc?.firedSubEventIds, []);

// --- a sub-event id shared shape check: orientation ran days 1..7 ---
s = reconstructArcState([log('orientation_committee', 1)], orientation.duration_days);
expect(`orientation active through its final day (${orientation.duration_days})`, s.activeArc?.event.id, 'orientation_committee');

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
