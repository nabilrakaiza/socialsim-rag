// Where do end-of-day's minutes actually go?
//
// Runs measured between 1m40s and 4m24s, and the diary was timed at 60-71s in
// two of them — but the slow run was never broken down, so the rest is
// unaccounted for. Splitting the request on a guess about which phase is the
// long pole would be premature.
//
// endDay already emits a stage as each phase begins, so timestamping those
// callbacks gives a per-phase profile with no changes to lib/.
//
//   scoring   -> reflecting : grading the day's answered beats
//   reflecting -> diary     : knowledge updates + affection deltas (parallel)
//   diary     -> saving     : diary generation + embedding
//   saving    -> done       : writes, ending check, day advance
//
// Each run seeds the same realistic day so the numbers are comparable: three
// characters with conversation, and answered events. Without messages the
// knowledge and affection calls are skipped entirely and the profile lies.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { startNewGame, endDay } from '../lib/orchestrator';
import type { EndDayStage } from '../lib/orchestrator';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');

const RUNS = 3;

const MESSAGES = [
  { character: 'hiyori', role: 'player', content: "saw you at the library yesterday, didn't want to interrupt" },
  { character: 'hiyori', role: 'npc', content: "...you noticed that? it was due today, I was dying." },
  { character: 'shiori', role: 'player', content: 'how do you think she actually finds the module?' },
  { character: 'shiori', role: 'npc', content: "she'd never say it's hard, but it is. don't make a thing of it." },
  { character: 'yuki', role: 'player', content: 'you free this weekend? been a while' },
  { character: 'yuki', role: 'npc', content: "yeah, I'd like that. it has been a while." },
];

const ANSWERED_EVENTS = [
  { event_id: 'rain_umbrella', player_action: 'Share the umbrella and walk her back without making it a moment.' },
  { event_id: 'shiori_checks_in', player_action: 'Be honest with Shiori about liking Hiyori, without asking her to do the work.' },
];

async function seedDay(): Promise<string> {
  const id = (await startNewGame(`profile-${Date.now()}`)).session_id;

  await supabase.from('messages').insert(
    MESSAGES.map((m) => ({ session_id: id, day: 1, ...m }))
  );
  await supabase.from('events_log').insert(
    ANSWERED_EVENTS.map((e) => ({ session_id: id, day_triggered: 1, affection_delta: 0, ...e }))
  );

  return id;
}

async function cleanup(id: string) {
  for (const t of ['lore_chunks', 'diary_entries', 'events_log', 'messages', 'game_state']) {
    await supabase.from(t).delete().eq('session_id', id);
  }
}

async function main() {
  const rows: Record<string, number>[] = [];

  for (let run = 1; run <= RUNS; run++) {
    const id = await seedDay();
    const marks: { stage: string; at: number }[] = [];
    const started = Date.now();

    await endDay(id, (stage: EndDayStage) => marks.push({ stage, at: Date.now() }));
    const finished = Date.now();

    const phase: Record<string, number> = {};
    for (let i = 0; i < marks.length; i++) {
      const next = marks[i + 1]?.at ?? finished;
      phase[marks[i].stage] = (next - marks[i].at) / 1000;
    }
    phase.total = (finished - started) / 1000;
    // Time before the first stage fires — fetching state and the day's rows.
    phase.setup = (marks[0] ? marks[0].at - started : 0) / 1000;

    rows.push(phase);
    console.log(
      `run ${run}: total ${phase.total.toFixed(1)}s  ` +
        `[setup ${phase.setup.toFixed(1)} · scoring ${(phase.scoring ?? 0).toFixed(1)} · ` +
        `reflecting ${(phase.reflecting ?? 0).toFixed(1)} · diary ${(phase.diary ?? 0).toFixed(1)} · ` +
        `saving ${(phase.saving ?? 0).toFixed(1)}]`
    );

    await cleanup(id);
  }

  const keys = ['setup', 'scoring', 'reflecting', 'diary', 'saving', 'total'];
  const avg = (k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0) / rows.length;
  const totalAvg = avg('total');

  console.log('\n=== average across runs ===');
  for (const k of keys.filter((k) => k !== 'total')) {
    const v = avg(k);
    const share = totalAvg > 0 ? (v / totalAvg) * 100 : 0;
    console.log(`  ${k.padEnd(11)} ${v.toFixed(1)}s  ${'█'.repeat(Math.round(share / 3))} ${share.toFixed(0)}%`);
  }
  console.log(`  ${'total'.padEnd(11)} ${totalAvg.toFixed(1)}s`);
  console.log(`\n  slowest run: ${Math.max(...rows.map((r) => r.total)).toFixed(1)}s (Vercel Hobby ceiling is 300s)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
