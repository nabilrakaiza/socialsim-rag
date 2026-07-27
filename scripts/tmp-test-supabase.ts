// Throwaway script to exercise the new game_state/messages/diary_entries
// helpers against the live DB — not part of the real game loop. Safe to
// delete once the batch-eval orchestrator exists and exercises these for
// real. Inserts/cleans up its own rows under a fixed test session_id.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import {
  getGameState,
  updateGameState,
  getMessagesForDay,
  getLastDiaryEntries,
  insertDiaryEntry,
} from '../lib/supabase';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-session';

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: 1,
    action_points: 3,
    affection: 25,
    relationship_stage: 'Acquaintance',
    yuki_affection: 10,
    confessed: false,
    game_over: false,
  });

  await supabase.from('messages').insert([
    { session_id: SESSION_ID, day: 1, character: 'hiyori', role: 'player', content: 'hey, what did you get up to this weekend?' },
    { session_id: SESSION_ID, day: 1, character: 'hiyori', role: 'npc', content: 'Nothing exciting. Studied. You?' },
  ]);
}

async function cleanup() {
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  await supabase.from('diary_entries').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function main() {
  await setup();

  const state = await getGameState(SESSION_ID);
  console.log('getGameState:', state);

  await updateGameState(SESSION_ID, { affection: 30, relationship_stage: 'Friend' });
  const updated = await getGameState(SESSION_ID);
  console.log('after updateGameState:', updated.affection, updated.relationship_stage);

  const messages = await getMessagesForDay(SESSION_ID, 1);
  console.log('getMessagesForDay:', messages.map((m) => `${m.role}: ${m.content}`));

  await insertDiaryEntry({
    session_id: SESSION_ID,
    day: 1,
    entry_text: 'Test entry text.',
    affection_tier: 2,
    trigger_type: 'periodic',
    event_id: null,
  });

  const entries = await getLastDiaryEntries(SESSION_ID, 2);
  console.log('getLastDiaryEntries:', entries.map((e) => `day ${e.day}: ${e.entry_text}`));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
