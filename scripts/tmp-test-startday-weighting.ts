// Checks the wiring the pure test can't: that startDay actually feeds past
// firings and the detail seed into the resolver. Live DB, no model calls.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { startDay } from '../lib/orchestrator';
import { loadEvents, findBeat, detailSeed } from '../lib/events';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-startday-weighting-session';
const DAY = 6;
const RUNS = 40;

async function cleanup() {
  await supabase.from('events_log').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function setup() {
  await cleanup();
  const state = await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: DAY,
    affection: 0,
    relationship_stage: 'Stranger',
    yuki_affection: 0,
  });
  if (state.error) throw new Error(state.error.message);

  const rows: Record<string, unknown>[] = [];
  const log = (event_id: string, day: number) =>
    rows.push({ session_id: SESSION_ID, event_id, day_triggered: day, player_action: 'x', affection_delta: 0 });

  // Three of the four Stranger-tier events have each fired three times;
  // accidental_follow never has.
  for (const id of ['same_class', 'met_with_friends_public', 'yuki_econs_help']) {
    for (const day of [1, 2, 3]) log(id, day);
  }
  // Every arc marked as already used, long enough ago that none is active, so
  // no arc starts mid-test and takes the segments over.
  for (const arc of loadEvents().filter((e) => e.type === 'extended_event')) log(arc.id, -100);

  const logs = await supabase.from('events_log').insert(rows);
  if (logs.error) throw new Error(logs.error.message);
}

async function main() {
  await setup();

  const firstOfDay: Record<string, number> = {};
  const coincidenceTitles = new Set<string>();
  let daysWithEvent = 0;

  for (let i = 0; i < RUNS; i++) {
    // Each call re-rolls the day: startDay discards the previous roll's
    // unanswered beats first.
    const plan = await startDay(SESSION_ID);
    const fired = plan.segments.filter((s) => s.event && !s.subEvent);
    if (fired.length > 0) {
      daysWithEvent++;
      const id = fired[0].event!.id;
      firstOfDay[id] = (firstOfDay[id] ?? 0) + 1;
    }
    for (const s of fired) {
      if (s.event!.id === 'met_with_friends_public') coincidenceTitles.add(s.event!.title);
    }
  }

  let failed = false;
  const check = (label: string, pass: boolean, detail: string) => {
    console.log(`${pass ? 'PASS' : 'FAIL'} ${label} — ${detail}`);
    if (!pass) failed = true;
  };

  console.log(`first regular event of the day over ${daysWithEvent} days:`, firstOfDay);
  const share = (firstOfDay.accidental_follow ?? 0) / daysWithEvent;
  // Uniform would put it near a third; the weights put it at 84-94% depending
  // on which segment fires first.
  check('the never-fired event leads', share > 0.7, `accidental_follow first on ${(100 * share).toFixed(0)}% of days`);

  const recalled = (findBeat('met_with_friends_public', loadEvents(), detailSeed(SESSION_ID, DAY))!.beat as { title: string }).title;
  check(
    'every roll of the same day shows the same details, and a lookup recalls them',
    coincidenceTitles.size === 1 && coincidenceTitles.has(recalled),
    `shown: ${[...coincidenceTitles].join(' | ') || '(never fired)'}; recalled: ${recalled}`
  );

  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
