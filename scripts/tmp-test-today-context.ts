// Checks that the chat prompt carries what a character has already been
// through today — and nothing she shouldn't know. Runs sendPlayerMessage for
// real against a throwaway session; the model call is stubbed so the prompt
// can be read off the wire, then one live call at the end to see it used.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { sendPlayerMessage } from '../lib/chat';
import { loadEvents, findBeat, detailSeed } from '../lib/events';
import type { NPCCharacter } from '../lib/gemma';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-today-context-session';
const DAY = 4;

const ACTIONS = {
  met_with_friends_public: 'asked what she was listening to and actually waited for the answer',
  cultural_show_rehearsal: 'handed her a water bottle and said the second run sounded steadier',
  shiori_checks_in: 'told Shiori straight that I like Hiyori and I am not playing games',
  yuki_econs_help: 'walked Yuki through the elasticity question step by step',
  same_class: 'sat two rows behind her and said nothing',
};

async function insert(table: string, row: Record<string, unknown>) {
  const { error } = await supabase.from(table).insert(row);
  if (error) throw new Error(`${table} insert failed: ${error.message}`);
}

async function setup() {
  await cleanup();
  await insert('game_state', {
    session_id: SESSION_ID,
    current_day: DAY,
    affection: 30,
    relationship_stage: 'Acquaintance',
    yuki_affection: 15,
  });

  const log = (event_id: string, day: number, player_action: string | null) =>
    insert('events_log', { session_id: SESSION_ID, event_id, day_triggered: day, player_action, affection_delta: 0 });

  // Yesterday: the arc began (3 days, so it covers today), plus an answered
  // beat that must not be mistaken for today's.
  await log('cultural_show', DAY - 1, null);
  await log('same_class', DAY - 1, ACTIONS.same_class);
  // Today, in the order they happened.
  await log('met_with_friends_public', DAY, ACTIONS.met_with_friends_public);
  await log('cultural_show_rehearsal', DAY, ACTIONS.cultural_show_rehearsal);
  await log('shiori_checks_in', DAY, ACTIONS.shiori_checks_in);
  await log('yuki_econs_help', DAY, ACTIONS.yuki_econs_help);
  // Rolled this morning for tonight; the player hasn't reached it yet.
  await log('library_late_night', DAY, null);
}

async function cleanup() {
  await supabase.from('events_log').delete().eq('session_id', SESSION_ID);
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  await supabase.from('game_state').delete().eq('session_id', SESSION_ID);
}

const realFetch = globalThis.fetch;
let stubModel = true;
let lastPrompt = '';
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes(':generateContent')) return realFetch(input, init);
  lastPrompt = (JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] }).contents[0].parts[0].text;
  if (!stubModel) return realFetch(input, init);
  return new Response(
    JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"reply":"stub"}' }] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}) as typeof fetch;

async function promptFor(character: NPCCharacter, day = DAY): Promise<string> {
  lastPrompt = '';
  // A bare greeting skips retrieval, so the prompt holds no lore chunks that
  // could muddy the "does not contain" checks below.
  await sendPlayerMessage({
    sessionId: SESSION_ID,
    character,
    day,
    relationshipStage: 'Acquaintance',
    playerMessage: 'hey',
    inGameHour: 18.5,
    activity: 'dinner',
  });
  return lastPrompt;
}

let failed = false;
function check(label: string, pass: boolean) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failed = true;
}

async function main() {
  await setup();
  const events = loadEvents();
  const beat = (id: string, day = DAY) => findBeat(id, events, detailSeed(SESSION_ID, day))!;
  const desc = (id: string, day = DAY) => beat(id, day).beat.description;
  const rubric = (id: string) => Object.values(beat(id).beat.affection_outcomes);
  const arc = events.find((e) => e.id === 'cultural_show')!;

  console.log('-- hiyori --');
  const hiyori = await promptFor('hiyori');
  check('has the answered event, with the same details the player saw', hiyori.includes(desc('met_with_friends_public')));
  check('has its title too, which is where the location lives', hiyori.includes((beat('met_with_friends_public').beat as { title: string }).title));
  check('has what Adrian did about it', hiyori.includes(ACTIONS.met_with_friends_public));
  check('has the answered arc sub-event', hiyori.includes(desc('cultural_show_rehearsal')) && hiyori.includes(ACTIONS.cultural_show_rehearsal));
  check('has the running arc', hiyori.includes('GOING ON THIS WEEK') && hiyori.includes(arc.title));
  check('events are in the order they happened', hiyori.indexOf(desc('met_with_friends_public')) < hiyori.indexOf(desc('cultural_show_rehearsal')));
  check("omits tonight's event, which hasn't happened yet", !hiyori.includes(desc('library_late_night')));
  check("omits yesterday's event", !hiyori.includes(ACTIONS.same_class));
  check("omits Shiori's event", !hiyori.includes(desc('shiori_checks_in')) && !hiyori.includes(ACTIONS.shiori_checks_in));
  check("omits Yuki's event", !hiyori.includes(desc('yuki_econs_help')) && !hiyori.includes(ACTIONS.yuki_econs_help));
  check(
    'no grading rubric',
    ['met_with_friends_public', 'cultural_show_rehearsal', 'library_late_night'].every((id) => rubric(id).every((line) => !hiyori.includes(line))) &&
      Object.values(arc.affection_outcomes).every((line) => !hiyori.includes(line))
  );
  check('no raw [placeholder]', !/\[(location|activity|module)\]/i.test(hiyori));

  console.log('\n-- shiori --');
  const shiori = await promptFor('shiori');
  check('has her own event', shiori.includes(desc('shiori_checks_in')) && shiori.includes(ACTIONS.shiori_checks_in));
  check("omits Hiyori's events", !shiori.includes(ACTIONS.met_with_friends_public) && !shiori.includes(ACTIONS.cultural_show_rehearsal));
  check("omits Hiyori's arc", !shiori.includes('GOING ON THIS WEEK'));

  console.log('\n-- yuki --');
  const yuki = await promptFor('yuki');
  check('has her own event', yuki.includes(desc('yuki_econs_help')) && yuki.includes(ACTIONS.yuki_econs_help));
  check("omits everyone else's", !yuki.includes(ACTIONS.met_with_friends_public) && !yuki.includes(ACTIONS.shiori_checks_in));
  check("omits Hiyori's arc", !yuki.includes('GOING ON THIS WEEK'));

  console.log('\n-- a day with nothing on it --');
  const quiet = await promptFor('hiyori', DAY + 5);
  check('adds no section at all', !quiet.includes('HAS BEEN THROUGH') && !quiet.includes('EARLIER TODAY'));
  check('prompt is otherwise intact', quiet.includes('RELEVANT MEMORY') && quiet.includes('CONVERSATION SO FAR'));

  console.log('\n-- the block as Hiyori sees it --');
  const start = hiyori.indexOf('WHAT HIYORI HAS BEEN THROUGH');
  console.log(hiyori.slice(start, hiyori.indexOf('CONVERSATION SO FAR')).trim());

  // Live: asked about the morning without restating it, at dinner.
  console.log('\n-- live reply --');
  await supabase.from('messages').delete().eq('session_id', SESSION_ID);
  stubModel = false;
  const question = 'random question — earlier today, when we bumped into each other. where was that again, and what did I even ask you?';
  const { reply } = await sendPlayerMessage({
    sessionId: SESSION_ID,
    character: 'hiyori',
    day: DAY,
    relationshipStage: 'Acquaintance',
    playerMessage: question,
    inGameHour: 18.75,
    activity: 'dinner',
  });
  console.log(`Adrian: ${question}`);
  console.log(`Hiyori: ${reply}`);

  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
