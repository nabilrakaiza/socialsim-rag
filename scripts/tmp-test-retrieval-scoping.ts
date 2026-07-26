// Throwaway script to verify the is_static/session_id scoping added to
// match_lore_chunks/match_lore_multi_character actually filters correctly.
// Calls the RPCs directly via supabase-js (not through lib/supabase.ts,
// which hasn't been updated to pass sessionId through yet) so this is a
// clean test of the migration itself. Inserts one temporary dynamic
// chunk, cleans it up after.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { embedText } from '../lib/embeddings.js';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_A = 'tmp-test-scoping-session-a';
const SESSION_B = 'tmp-test-scoping-session-b';
const DISTINCTIVE_CONTENT = 'ZZZ_TEST_CHUNK: Adrian brought Hiyori a specific brand of instant noodles she mentioned liking once, unprompted.';

async function setup() {
  // lore_chunks.session_id FK's to game_state.session_id — needs a real row first.
  const { error: gameStateError } = await supabase.from('game_state').insert({
    session_id: SESSION_A,
    current_day: 1,
    affection: 0,
    yuki_affection: 0,
  });
  if (gameStateError) throw gameStateError;

  const embedding = await embedText(DISTINCTIVE_CONTENT);
  const { error } = await supabase.from('lore_chunks').insert({
    content: DISTINCTIVE_CONTENT,
    character: 'hiyori',
    source_file: 'tmp-test-scoping',
    chunk_index: 0,
    is_static: false,
    session_id: SESSION_A,
    embedding,
  });
  if (error) throw error;
  return embedding;
}

async function cleanup() {
  await supabase.from('lore_chunks').delete().eq('source_file', 'tmp-test-scoping');
  await supabase.from('game_state').delete().eq('session_id', SESSION_A);
}

function containsDistinctiveChunk(rows: { content: string }[] | null): boolean {
  return (rows ?? []).some((r) => r.content === DISTINCTIVE_CONTENT);
}

async function main() {
  const embedding = await setup();

  // Low threshold + high match_count so we see everything for 'hiyori',
  // isolating the is_static/session_id filter rather than similarity ranking.
  const baseParams = {
    query_embedding: embedding,
    match_character: 'hiyori',
    match_count: 50,
    similarity_threshold: 0.0,
  };

  const { data: noSession, error: e1 } = await supabase.rpc('match_lore_chunks', {
    ...baseParams,
    match_session_id: null,
  });
  if (e1) throw e1;
  console.log('no session_id passed -> dynamic chunk visible?', containsDistinctiveChunk(noSession), `(${noSession?.length} rows)`);

  const { data: ownSession, error: e2 } = await supabase.rpc('match_lore_chunks', {
    ...baseParams,
    match_session_id: SESSION_A,
  });
  if (e2) throw e2;
  console.log('own session_id passed -> dynamic chunk visible?', containsDistinctiveChunk(ownSession), `(${ownSession?.length} rows)`);

  const { data: otherSession, error: e3 } = await supabase.rpc('match_lore_chunks', {
    ...baseParams,
    match_session_id: SESSION_B,
  });
  if (e3) throw e3;
  console.log('different session_id passed -> dynamic chunk visible?', containsDistinctiveChunk(otherSession), `(${otherSession?.length} rows)`);

  // Same three checks via match_lore_multi_character.
  const multiBase = {
    query_embedding: embedding,
    match_characters: ['hiyori', 'shiori'],
    match_count: 50,
    similarity_threshold: 0.0,
  };

  const { data: multiNoSession, error: e4 } = await supabase.rpc('match_lore_multi_character', {
    ...multiBase,
    match_session_id: null,
  });
  if (e4) throw e4;
  console.log('multi-character, no session_id -> dynamic chunk visible?', containsDistinctiveChunk(multiNoSession));

  const { data: multiOwnSession, error: e5 } = await supabase.rpc('match_lore_multi_character', {
    ...multiBase,
    match_session_id: SESSION_A,
  });
  if (e5) throw e5;
  console.log('multi-character, own session_id -> dynamic chunk visible?', containsDistinctiveChunk(multiOwnSession));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
