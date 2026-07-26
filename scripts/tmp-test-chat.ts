// Throwaway script to exercise sendPlayerMessage end-to-end against the
// live DB + Gemini API. Not part of the real pipeline — safe to delete
// once the game loop calls this for real. Sends two turns in the same
// session/day to confirm the second turn's history actually includes
// the first (the bug we just fixed), and that a Yuki message inserted
// separately doesn't leak into Hiyori's history (the character-filter fix).

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { sendPlayerMessage } from '../lib/chat.js';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-chat-session';
const DAY = 1;

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: DAY,
    affection: 30,
    relationship_stage: 'Acquaintance',
    yuki_affection: 15,
  });

  // Pre-existing Yuki message today — should NOT leak into Hiyori's history below.
  await supabase.from('messages').insert({
    session_id: SESSION_ID,
    day: DAY,
    character: 'yuki',
    role: 'player',
    content: 'hey yuki, are you free this weekend?',
  });
}

async function cleanup() {
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

async function main() {
  await setup();

  const first = await sendPlayerMessage({
    sessionId: SESSION_ID,
    character: 'hiyori',
    day: DAY,
    relationshipStage: 'Acquaintance',
    playerMessage: "hey, saw you at the library yesterday, didn't want to interrupt since you looked deep in that lab report",
  });
  console.log('turn 1 reply:', first.reply);

  const second = await sendPlayerMessage({
    sessionId: SESSION_ID,
    character: 'hiyori',
    day: DAY,
    relationshipStage: 'Acquaintance',
    playerMessage: "so how'd it go? the lab report",
  });
  console.log('\nturn 2 reply:', second.reply);
  console.log('(turn 2 should read as a continuation of turn 1, not a fresh greeting)');

  const { data: hiyoriMessages } = await supabase
    .from('messages')
    .select('character, role, content')
    .eq('session_id', SESSION_ID)
    .eq('character', 'hiyori')
    .order('created_at');
  console.log('\nall persisted hiyori messages:', hiyoriMessages);

  const { data: allMessages } = await supabase
    .from('messages')
    .select('character, role, content')
    .eq('session_id', SESSION_ID)
    .order('created_at');
  console.log('\nall persisted messages (incl. yuki):', allMessages?.length, 'total rows');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
