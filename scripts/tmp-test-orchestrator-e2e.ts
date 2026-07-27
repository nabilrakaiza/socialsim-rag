// Drives a full day through the orchestrator against the live DB + API.
//
// Forces an arc to be active on day 1 by pre-inserting its start row, which
// makes the run deterministic (arc triggering is a 25% roll) and exercises
// three things at once: the in-arc segment path, that the arc-start marker
// is NOT scored as an ignored beat, and that answered vs unanswered beats
// take different scoring paths.

import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { startDay, recordEventResponse, endDay } from '../lib/orchestrator';
import { loadEvents } from '../lib/events';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION_ID = 'tmp-test-orchestrator-session';
const ARC_ID = 'group_project_week'; // 6 days, so day 1 is mid-arc, not a final day

async function setup() {
  await supabase.from('game_state').insert({
    session_id: SESSION_ID,
    current_day: 1,
    affection: 30,
    relationship_stage: 'Acquaintance',
    yuki_affection: 15,
  });

  // Arc-start marker, exactly as startDay would write it. endDay must ignore
  // this row rather than charge a skip penalty for the arc merely beginning.
  await supabase.from('events_log').insert({
    session_id: SESSION_ID,
    event_id: ARC_ID,
    day_triggered: 1,
    player_action: null,
    affection_delta: 0,
  });
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

  const plan = await startDay(SESSION_ID);
  console.log(`day ${plan.day} | schedule segments: ${plan.schedule.length} | startedArc: ${plan.startedArc?.id ?? 'none (already active)'}`);
  console.log(`activeArc: ${plan.activeArc?.event.id} started day ${plan.activeArc?.startDay}`);
  console.log('\nresolved activity segments:');
  for (const seg of plan.segments) {
    const what = seg.subEvent
      ? `SUB ${seg.subEvent.id}`
      : seg.event
        ? `EVENT ${seg.event.id}`
        : `flavor: ${seg.flavor}`;
    console.log(`  ${seg.segment.padEnd(21)} ${what}`);
  }

  // Answer the first fired beat, deliberately leave any others unanswered so
  // both scoring paths run in one day.
  const fired = plan.segments.filter((s) => s.eventLogId);
  if (fired.length > 0) {
    await recordEventResponse(
      fired[0].eventLogId!,
      "Split the work so she isn't carrying the useless groupmates alone, take the section she'd hate most, and check in without hovering."
    );
    console.log(`\nanswered: ${fired[0].subEvent?.id ?? fired[0].event?.id}`);
    console.log(`left unanswered: ${fired.slice(1).map((s) => s.subEvent?.id ?? s.event?.id).join(', ') || '(none)'}`);
  }

  const { data: beforeRows } = await supabase
    .from('events_log').select('event_id, player_action, affection_delta')
    .eq('session_id', SESSION_ID).order('created_at');
  console.log('\nevents_log before endDay:', beforeRows);

  console.log('\n--- running endDay (event scoring + batch eval) ---');
  const result = await endDay(SESSION_ID);
  console.log('endDay result:', result);

  const { data: afterRows } = await supabase
    .from('events_log').select('event_id, player_action, affection_delta')
    .eq('session_id', SESSION_ID).order('created_at');
  console.log('\nevents_log after endDay:', afterRows);

  const arcMarker = (afterRows ?? []).find((r) => r.event_id === ARC_ID);
  console.log(`\narc-start marker delta stayed 0 (not skip-penalised): ${arcMarker?.affection_delta === 0}`);

  const { data: state } = await supabase
    .from('game_state').select('current_day, affection, yuki_affection, relationship_stage, game_over, ending_id')
    .eq('session_id', SESSION_ID).single();
  console.log('final game_state:', state);
  console.log(`day advanced 1 -> 2: ${state?.current_day === 2}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
