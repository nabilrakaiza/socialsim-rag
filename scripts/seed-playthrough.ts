// Builds a multi-day session by running the real pipeline, so
// scripts/eval-memory.ts has genuine accumulated memory to measure.
//
// Runs the actual endDay for each day rather than writing chunks directly:
// the point is to measure what the game produces, and hand-written chunks
// would measure my prose instead of the knowledge-update prompt's.
//
// The days are deliberately about DIFFERENT things. Seeding ten variations of
// the same conversation would guarantee the clustering this is meant to test,
// and prove nothing. If chunks still collapse together on input this varied,
// that's the prompt's doing.
//
// Usage: npx tsx scripts/seed-playthrough.ts [days]

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { startNewGame, endDay } from '../lib/orchestrator';
import type { NPCCharacter } from '../lib/gemma';

const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SERVICE_ROLE ?? '');

interface Turn {
  character: NPCCharacter;
  player: string;
  npc: string;
}

const DAYS: Turn[][] = [
  [{ character: 'hiyori', player: 'shiori said you cycle — where do you usually ride?', npc: "east coast mostly, sometimes bukit timah if i'm feeling ambitious. it's flat until it very much isn't." }],
  [{ character: 'shiori', player: 'is she always this hard to read or is it just me', npc: "it's not just you. she deflects. it isn't personal, it's a reflex." }],
  [{ character: 'hiyori', player: 'how did the microbiology lab go?', npc: 'three hours of safety briefings and i am somehow further behind than when i started.' },
   { character: 'yuki', player: 'econs still eating your week?', npc: 'always. i have started dreaming in indifference curves, which cannot be healthy.' }],
  [{ character: 'hiyori', player: 'i found a mixed rice stall near science that does a decent egg', npc: "...the one by the carpark? i go there twice a week. don't tell shiori, she thinks i eat properly." }],
  [{ character: 'yuki', player: 'do you still do that thing where you reorganise your desk instead of studying', npc: 'i have refined it. now i reorganise, then study, then reorganise again to recover.' }],
  [{ character: 'hiyori', player: 'you looked wiped at the committee thing yesterday', npc: "tutoring nights are tuesday and thursday. by wednesday i'm running on spite." },
   { character: 'shiori', player: 'should i offer to take some of the spreadsheet work', npc: 'offer once, then just do it. asking twice makes it a favour she has to accept.' }],
  [{ character: 'hiyori', player: 'do you actually like the environmental bio track or was it a default', npc: "i picked it. people keep assuming i fell into it, which is its own kind of annoying." }],
  [{ character: 'yuki', player: 'random but do you remember mr tan\'s chem class', npc: 'i remember you setting your worksheet on fire. selectively. allegedly.' }],
  [{ character: 'hiyori', player: 'it rained the whole way back from the library today', npc: 'i know. i watched it from inside and felt smug, then had to walk home in it anyway.' },
   { character: 'shiori', player: 'she mentioned the rain thing to you?', npc: 'she mentioned it. she does not usually mention things. draw your own conclusions.' }],
  [{ character: 'hiyori', player: 'how are the succulents holding up', npc: 'two thriving, one in what i can only describe as a difficult phase. i am not giving up on it.' }],
];

async function main() {
  const days = Number(process.argv[2] ?? DAYS.length);
  const id = (await startNewGame()).session_id;
  console.log(`session ${id}\n`);

  for (let day = 1; day <= Math.min(days, DAYS.length); day++) {
    const turns = DAYS[day - 1];
    await supabase.from('messages').insert(
      turns.flatMap((turn) => [
        { session_id: id, day, character: turn.character, role: 'player', content: turn.player },
        { session_id: id, day, character: turn.character, role: 'npc', content: turn.npc },
      ])
    );

    const started = Date.now();
    const result = await endDay(id);
    console.log(
      `day ${String(day).padStart(2)}  ${((Date.now() - started) / 1000).toFixed(0)}s  ` +
        `affection ${result.newAffection}  ${result.diaryGenerated ? 'diary' : '     '}  ` +
        `[${turns.map((t) => t.character).join(', ')}]`
    );
  }

  const { count } = await supabase
    .from('lore_chunks')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', id)
    .eq('is_static', false);

  console.log(`\n${count} dynamic chunks written`);
  console.log(`\nnpm run eval-memory -- --session ${id}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
