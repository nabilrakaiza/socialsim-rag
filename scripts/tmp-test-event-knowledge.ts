// Checks that a fired event actually reaches the characters' knowledge bases.
// Before this, runEndOfDayBatchEval derived knowledge from `messages` alone,
// so an event left no trace in what anyone remembered.
//
// Two things under test:
//   1. An event with NO conversation still produces a knowledge chunk — the
//      old code skipped a character entirely when she had no messages.
//   2. Events are attributed by PARTICIPANT, not by whose meter moves.
//      shiori_checks_in moves Hiyori's meter but Shiori witnessed it, so it
//      must land in Shiori's chunk and NOT Hiyori's.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { endDay } from '../lib/orchestrator';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-event-knowledge-session';

const SHIORI_ACTION = 'Told Shiori honestly that I like Hiyori but do not want to push, and asked what she thought without asking her to do the work for me.';
const HIYORI_ACTION = 'Shared my umbrella and walked her back without making it into a moment.';

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: 1,
    affection: 35,
    relationship_stage: 'Acquaintance',
    yuki_affection: 10,
  });

  // Deliberately NO messages rows — the only input is events, which is the
  // case the old code dropped on the floor.
  await supabase.from('events_log').insert([
    { session_id: SESSION_ID, event_id: 'shiori_checks_in', day_triggered: 1, player_action: SHIORI_ACTION, affection_delta: 0 },
    { session_id: SESSION_ID, event_id: 'rain_umbrella', day_triggered: 1, player_action: HIYORI_ACTION, affection_delta: 0 },
  ]);
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
  console.log('seeded two answered events, zero messages');
  console.log('  shiori_checks_in  (participant: shiori, affects: hiyori)');
  console.log('  rain_umbrella     (participant + affects: hiyori)\n');

  await endDay(SESSION_ID);

  // chunk_index 0 is the knowledge update; batch-eval also indexes the diary
  // entry under character 'hiyori' at chunk_index 2. Without this filter the
  // diary overwrites the knowledge chunk when keyed by character, and the
  // checks below silently pass against the wrong text.
  const { data: chunks } = await supabase
    .from('lore_chunks')
    .select('character, content, chunk_index')
    .eq('session_id', SESSION_ID)
    .eq('is_static', false)
    .eq('chunk_index', 0);

  const byCharacter = Object.fromEntries((chunks ?? []).map((c) => [c.character, c.content]));

  for (const [character, content] of Object.entries(byCharacter)) {
    console.log(`--- ${character} ---\n${content}\n`);
  }

  const shioriChunk = byCharacter['shiori'] ?? '';
  const hiyoriChunk = byCharacter['hiyori'] ?? '';

  // Guard against the dedupe trap returning: if a diary ever lands here the
  // character key would collide again.
  const duplicated = (chunks ?? []).length !== new Set((chunks ?? []).map((c) => c.character)).size;

  console.log('--- checks ---');
  console.log(`one knowledge chunk per character (no diary leaking in): ${!duplicated}`);
  const shioriExists = Boolean(shioriChunk);
  const hiyoriExists = Boolean(hiyoriChunk);
  console.log(`shiori got a chunk despite zero messages: ${shioriExists}`);
  console.log(`hiyori got a chunk despite zero messages: ${hiyoriExists}`);
  console.log(`yuki correctly got NO chunk (no events, no messages): ${!byCharacter['yuki']}`);

  // Weak but meaningful signal: Shiori's chunk should be about the conversation
  // she had, Hiyori's about the rain. Word-bounded because an unanchored /rain/
  // matches "restraint", which Shiori's chunk legitimately used — that produced
  // a false failure the first time round.
  const rainWords = /\b(umbrella|rain|raining|downpour)\b/i;
  console.log(`hiyori's chunk references the rain event: ${rainWords.test(hiyoriChunk)}`);
  console.log(`shiori's chunk does NOT mention the rain (it wasn't hers): ${!rainWords.test(shioriChunk)}`);

  const ok = shioriExists && hiyoriExists && !byCharacter['yuki'] && !duplicated && rainWords.test(hiyoriChunk) && !rainWords.test(shioriChunk);
  console.log(`\n${ok ? 'PASS — events now reach the knowledge base' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
