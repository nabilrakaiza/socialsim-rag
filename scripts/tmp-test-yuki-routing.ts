// Verifies the `affects` field actually routes deltas to the right meter.
// The e2e run never exercised this — no Yuki event happened to fire — so
// this drives endDay directly with pre-seeded events_log rows instead of
// waiting on a random roll.
//
// Covers three routings in one day:
//   yuki_econs_help              -> affects: 'yuki'  (declared on the event)
//   yuki_econs_crunch_daytime_prep -> sub-event, must INHERIT 'yuki' from its
//                                   parent arc, which is the case most likely
//                                   to break since sub-events carry no affects
//   rain_umbrella                -> no affects field, defaults to Hiyori

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { endDay } from '../lib/orchestrator.js';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-yuki-routing-session';

const START_AFFECTION = 30;
const START_YUKI = 40;

// All answered well, so every delta should be positive — which makes the
// direction of movement unambiguous when checking which meter moved.
const SEEDED = [
  { event_id: 'yuki_econs_help', action: "Actually walk her through the concept properly instead of just giving the answer, and don't make a thing of it being an excuse to hang out." },
  { event_id: 'yuki_econs_crunch_daytime_prep', action: "Work at her pace, let her get things wrong without jumping in, and stay patient when she's clearly frustrated with herself." },
  { event_id: 'rain_umbrella', action: "Offer to share the umbrella without making it a moment, angle it over her, keep walking and talking normally." },
];

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: 1,
    affection: START_AFFECTION,
    relationship_stage: 'Acquaintance',
    yuki_affection: START_YUKI,
  });

  for (const { event_id, action } of SEEDED) {
    await supabase.from('events_log').insert({
      session_id: SESSION_ID,
      event_id,
      day_triggered: 1,
      player_action: action,
      affection_delta: 0,
    });
  }
}

async function cleanup() {
  await supabase.from('lore_chunks').delete().eq('session_id', SESSION_ID);
  await supabase.from('diary_entries').delete().eq('session_id', SESSION_ID);
  await supabase.from('events_log').delete().eq('session_id', SESSION_ID);
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function main() {
  await setup();

  console.log(`start: affection ${START_AFFECTION}, yuki_affection ${START_YUKI}`);
  console.log('seeded (all answered):', SEEDED.map((s) => s.event_id).join(', '));

  const result = await endDay(SESSION_ID);
  console.log('\nendDay result:', result);

  const { data: rows } = await supabase
    .from('events_log').select('event_id, affection_delta')
    .eq('session_id', SESSION_ID).order('created_at');
  console.log('\nper-event deltas:', rows);

  const byId = Object.fromEntries((rows ?? []).map((r) => [r.event_id, r.affection_delta]));
  const yukiDeltaSum = byId['yuki_econs_help'] + byId['yuki_econs_crunch_daytime_prep'];
  const hiyoriDeltaSum = byId['rain_umbrella'];

  const yukiMoved = result.newYukiAffection - START_YUKI;
  const hiyoriMoved = result.newAffection - START_AFFECTION;

  console.log('\n--- routing checks ---');
  console.log(`yuki meter moved by ${yukiMoved}, expected ${yukiDeltaSum}: ${yukiMoved === yukiDeltaSum}`);
  console.log(`hiyori meter moved by ${hiyoriMoved}, expected ${hiyoriDeltaSum}: ${hiyoriMoved === hiyoriDeltaSum}`);
  console.log(`eventAffectionDelta (${result.eventAffectionDelta}) == hiyori total: ${result.eventAffectionDelta === hiyoriDeltaSum}`);
  console.log(`eventYukiAffectionDelta (${result.eventYukiAffectionDelta}) == yuki total: ${result.eventYukiAffectionDelta === yukiDeltaSum}`);
  console.log(`sub-event inherited 'yuki' from its parent arc: ${byId['yuki_econs_crunch_daytime_prep'] !== undefined && yukiMoved === yukiDeltaSum}`);

  const ok = yukiMoved === yukiDeltaSum && hiyoriMoved === hiyoriDeltaSum;
  console.log(`\n${ok ? 'ROUTING CORRECT' : 'ROUTING WRONG — deltas landed on the wrong meter'}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
