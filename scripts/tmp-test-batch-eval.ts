// Throwaway script to exercise runEndOfDayBatchEval end-to-end against the
// live DB + Gemini API. Not part of the real pipeline — safe to delete once
// the game loop calls this for real. Inserts/cleans up its own rows under a
// fixed test session_id.
//
// No prior diary entries exist for this session, so the periodic trigger
// (see lib/relationship.ts's checkDiaryTrigger) always fires on this run —
// deliberate, so the diary-generation + lore-chunk-indexing path actually
// gets exercised instead of being skipped.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { runEndOfDayBatchEval } from '../lib/batch-eval';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-batch-eval-session';
const DAY = 1;

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: DAY,
    action_points: 3,
    affection: 30,
    relationship_stage: 'Acquaintance',
    yuki_affection: 15,
    confessed: false,
    game_over: false,
  });

  await supabase.from('messages').insert([
    { session_id: SESSION_ID, day: DAY, character: 'hiyori', role: 'player', content: "hey, saw you at the library yesterday, didn't want to interrupt since you looked deep in that lab report" },
    { session_id: SESSION_ID, day: DAY, character: 'hiyori', role: 'npc', content: '...you noticed that? it was due today, I was dying.' },
    { session_id: SESSION_ID, day: DAY, character: 'hiyori', role: 'player', content: "how'd it go? you looked stressed" },
    { session_id: SESSION_ID, day: DAY, character: 'hiyori', role: 'npc', content: "fine. i mean, it's done. thanks for asking I guess." },

    { session_id: SESSION_ID, day: DAY, character: 'yuki', role: 'player', content: 'you free this weekend? thought we could catch up' },
    { session_id: SESSION_ID, day: DAY, character: 'yuki', role: 'npc', content: "yeah, I'd like that. it's been a while." },

    { session_id: SESSION_ID, day: DAY, character: 'shiori', role: 'player', content: 'hiyori mentioned you helped her with the lab report, that was nice of you' },
    { session_id: SESSION_ID, day: DAY, character: 'shiori', role: 'npc', content: "she'd do the same for me. don't read too much into it." },
  ]);
}

async function cleanup() {
  await supabase.from('lore_chunks').delete().eq('session_id', SESSION_ID);
  await supabase.from('diary_entries').delete().eq('session_id', SESSION_ID);
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function main() {
  await setup();

  const result = await runEndOfDayBatchEval({ sessionId: SESSION_ID });
  console.log('runEndOfDayBatchEval result:', result);

  const { data: chunks } = await supabase
    .from('lore_chunks')
    .select('character, source_file, chunk_index, content')
    .eq('session_id', SESSION_ID);
  console.log('\ninserted lore_chunks:', chunks);

  const { data: diary } = await supabase
    .from('diary_entries')
    .select('day, trigger_type, affection_tier, entry_text')
    .eq('session_id', SESSION_ID);
  console.log('\ninserted diary_entries:', diary);

  const { data: state } = await supabase
    .from('game_state')
    .select('affection, yuki_affection, relationship_stage')
    .eq('session_id', SESSION_ID)
    .single();
  console.log('\nfinal game_state:', state);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
