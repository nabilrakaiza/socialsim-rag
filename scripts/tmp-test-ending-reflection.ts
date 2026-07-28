// Exercises the ending reflection against a session that looks like a real
// playthrough: diary entries across several days, knowledge chunks for both
// Hiyori and Yuki, and a resolved ending.
//
// Seeded rather than played, because playing thirty days would take hours of
// LLM time. The shapes match exactly what the game writes.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { buildEndingReflection } from '../lib/ending-reflection';
import { embedText } from '../lib/embeddings';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');
const SESSION = 'tmp-test-ending-reflection';

const DIARY = [
  { day: 3, text: `[Day 3 — In-game]\nOrientation committee again. Adrian was there, colour-coding the venue spreadsheet like a lunatic. Fine, it was useful. I'm not saying it was impressive. Lab report due Thursday and I've written one paragraph.` },
  { day: 9, text: `[Day 9 — In-game]\nHe noticed I'd been quiet all week and didn't make a thing of it, just asked once and let it go when I said I was fine. Which I was. Mostly. Anyway the laksa at UTown has gone downhill.` },
  { day: 17, text: `[Day 17 — In-game]\nRained on the way back from the library and he had an umbrella and just — walked me back. Didn't make it into a moment. I keep thinking about how he didn't make it into a moment. That's annoying of me.` },
  { day: 24, text: `[Day 24 — In-game]\nShiori asked, in that way she does where it isn't really a question. I said there was nothing to tell. There isn't. He's just around a lot, and he remembers things, and I don't know what to do with that.` },
];

const HIYORI_KNOWLEDGE = [
  'Adrian took on the tedious half of the committee work without being asked — Hiyori read it as someone who would rather things went well than be seen to fix them.',
  'Adrian noticed she was struggling and asked once, without pressing — Hiyori took the restraint as the considerate part, not the asking.',
  'Adrian shared his umbrella and walked her back without turning it into a gesture — Hiyori found the lack of performance harder to dismiss than the kindness itself.',
];

const YUKI_KNOWLEDGE = [
  'Adrian agreed to meet up without hesitating — Yuki read the speed of it as him still making room for her.',
  'Adrian stayed on the call long after the econs problem was solved — Yuki noticed he did not seem in a hurry to go.',
  'Adrian remembered which module she was struggling with weeks later — Yuki filed that away and said nothing about it.',
];

async function setup(yukiAffection: number) {
  await supabase.from('game_state').insert({
    session_id: SESSION,
    current_day: 26,
    affection: 62,
    relationship_stage: 'Friend',
    yuki_affection: yukiAffection,
    confessed: true,
    game_over: true,
    ending_id: 'friend_zone_end',
  });

  await supabase.from('diary_entries').insert(
    DIARY.map((d) => ({
      session_id: SESSION,
      day: d.day,
      entry_text: d.text,
      affection_tier: 3,
      trigger_type: 'periodic',
      event_id: null,
    }))
  );

  // Diary entries are also indexed as chunks by the real batch eval, so seed
  // one that way too — the reflection has to filter those out of "impressions"
  // or the archive gets duplicated back as things she noticed.
  const chunks = [
    ...HIYORI_KNOWLEDGE.map((content, i) => ({ content, character: 'hiyori', chunk_index: i })),
    { content: DIARY[3].text, character: 'hiyori', chunk_index: 90 },
    ...YUKI_KNOWLEDGE.map((content, i) => ({ content, character: 'yuki', chunk_index: i })),
  ];

  for (const c of chunks) {
    await supabase.from('lore_chunks').insert({
      content: c.content,
      character: c.character,
      source_file: `dynamic-day-${c.chunk_index}`,
      chunk_index: c.chunk_index,
      is_static: false,
      session_id: SESSION,
      embedding: await embedText(c.content),
    });
  }
}

async function cleanup() {
  for (const t of ['lore_chunks', 'diary_entries', 'events_log', 'messages', 'game_state']) {
    await supabase.from(t).delete().eq('session_id', SESSION);
  }
}

async function run(label: string, yukiAffection: number) {
  await cleanup();
  await setup(yukiAffection);

  const started = Date.now();
  const reflection = await buildEndingReflection(SESSION);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}  (yuki_affection ${yukiAffection}) — generated in ${seconds}s`);
  console.log('='.repeat(70));
  console.log(`\n--- her final entry (${reflection.finalEntry.split(/\s+/).length} words) ---`);
  console.log(reflection.finalEntry);
  console.log(`\n--- archive: ${reflection.archive.length} earlier entries ---`);
  console.log(`\n--- yuki epilogue ---`);
  console.log(reflection.yukiEpilogue ?? '(none — correctly withheld)');

  // The archive must not leak back in as "things she noticed".
  const dupes = reflection.archive.filter((a) => reflection.finalEntry.includes(a.text.slice(0, 50)));
  console.log(`\ndiary duplicated into the final entry: ${dupes.length} (expected 0)`);
}

async function main() {
  await run('above the reveal floor', 58);
  await run('below the reveal floor', 12);
  await cleanup();
  console.log('\n(cleaned up)');
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exitCode = 1;
});
