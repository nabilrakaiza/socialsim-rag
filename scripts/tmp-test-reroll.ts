// A refresh mid-day used to duplicate the day's beats. The client keeps its
// plan in memory, so reloading lost it, asked for a new day, and the first
// set stayed behind unanswered — collecting skip penalties for events the
// player never saw.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { startNewGame, startDay, recordEventResponse } from '../lib/orchestrator';
import { loadEvents } from '../lib/events';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');

const rows = (id: string) =>
  supabase.from('events_log').select('event_id, player_action').eq('session_id', id);

async function main() {
  const id = (await startNewGame(`reroll-${Date.now()}`)).session_id;
  let failures = 0;

  const first = await startDay(id);
  const afterFirst = (await rows(id)).data ?? [];

  // Answer one beat, so the "answered work survives" case is covered too.
  const answerable = first.segments.find((s) => s.eventLogId);
  if (answerable) {
    await recordEventResponse(answerable.eventLogId!, 'Took it seriously and stayed for the whole thing.');
  }

  // The refresh.
  const second = await startDay(id);
  const afterSecond = (await rows(id)).data ?? [];

  const unanswered = afterSecond.filter((r) => r.player_action === null).length;
  const answered = afterSecond.filter((r) => r.player_action !== null).length;
  const firstUnanswered = afterFirst.filter((r) => r.player_action === null).length;

  console.log(`first startDay        — ${afterFirst.length} rows (${firstUnanswered} unanswered)`);
  console.log(`answered one beat     — ${answerable ? answerable.subEvent?.id ?? answerable.event?.id : '(none fired)'}`);
  console.log(`after the "refresh"   — ${afterSecond.length} rows (${answered} answered, ${unanswered} unanswered)`);

  // Row count is the wrong invariant — a re-roll is a fresh random day and may
  // legitimately produce more beats than the first, or start an arc. What must
  // hold is that no unanswered beat from the ABANDONED roll survives: every
  // unanswered row should belong to the new plan, or be an arc marker.
  const { data: rowsWithIds } = await supabase
    .from('events_log')
    .select('id, event_id, player_action')
    .eq('session_id', id);

  const newPlanIds = new Set(second.segments.map((s) => s.eventLogId).filter(Boolean));
  const arcIds = new Set(loadEvents().filter((e) => e.type === 'extended_event').map((e) => e.id));

  const orphans = (rowsWithIds ?? []).filter(
    (r) => r.player_action === null && !newPlanIds.has(r.id) && !arcIds.has(r.event_id)
  );

  if (orphans.length > 0) failures++;
  console.log(`\norphaned beats from the abandoned roll: ${orphans.length} (expected 0)`);
  if (orphans.length) console.log('  ', orphans.map((o) => o.event_id));

  if (answerable) {
    const kept = afterSecond.some((r) => r.player_action !== null);
    if (!kept) failures++;
    console.log(`answered beat survived the re-roll: ${kept}`);
  }

  for (const t of ['lore_chunks', 'diary_entries', 'events_log', 'messages', 'game_state']) {
    await supabase.from(t).delete().eq('session_id', id);
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}`);
  if (failures) process.exitCode = 1;
}
main();
