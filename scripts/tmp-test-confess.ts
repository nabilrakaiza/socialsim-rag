// Checks confess() resolves and persists an ending immediately, at each
// affection band. No LLM calls — the ending rules are deterministic.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { confess } from '../lib/orchestrator';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-confess-session';

const cases = [
  { affection: 85, day: 12, expect: 'good_end' },
  { affection: 80, day: 3, expect: 'good_end' },       // boundary
  { affection: 79, day: 3, expect: 'friend_zone_end' },
  { affection: 40, day: 20, expect: 'friend_zone_end' }, // boundary
  { affection: 39, day: 20, expect: 'bad_end' },
  { affection: 0, day: 1, expect: 'bad_end' },          // day 1 confession still resolves
];

async function reset(affection: number, day: number) {
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: day,
    affection,
    relationship_stage: 'Acquaintance',
    yuki_affection: 90, // deliberately high: a confession must outrank Yuki's route
    confessed: false,
    game_over: false,
  });
}

async function cleanup() {
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function main() {
  let failures = 0;

  for (const c of cases) {
    await reset(c.affection, c.day);
    const ending = await confess(SESSION_ID);

    const { data: state } = await supabase
      .from('game_state')
      .select('confessed, game_over, ending_id')
      .eq('session_id', SESSION_ID)
      .single();

    const ok =
      ending === c.expect &&
      state?.ending_id === c.expect &&
      state?.confessed === true &&
      state?.game_over === true;

    if (!ok) failures++;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} affection ${String(c.affection).padStart(3)} day ${String(c.day).padStart(2)} -> ${ending}` +
      `  [persisted: ending_id=${state?.ending_id} confessed=${state?.confessed} game_over=${state?.game_over}]`
    );
  }

  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  console.log('(yuki_affection was 90 throughout — a confession must outrank the secret route)');
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
