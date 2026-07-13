// Throwaway script to check generateAffectionDelta against the live API
// with a couple of contrasting conversations. Not part of the real
// pipeline — safe to delete once the batch-eval orchestrator exists.

import 'dotenv/config';

import { generateAffectionDelta } from '../lib/gemma.js';

async function main() {
  const warm = await generateAffectionDelta(
    'hiyori',
    [
      { role: 'player', content: "hey, saw you at the library yesterday, didn't want to interrupt since you looked deep in that lab report" },
      { role: 'npc', content: "...you noticed that? it was due today, I was dying." },
      { role: 'player', content: "how'd it go? you looked stressed" },
      { role: 'npc', content: "fine. i mean, it's done. thanks for asking I guess." },
    ],
    30,
    'Acquaintance'
  );
  console.log('warm/attentive conversation delta:', warm);

  const flat = await generateAffectionDelta(
    'hiyori',
    [
      { role: 'player', content: 'yo' },
      { role: 'npc', content: 'hey' },
    ],
    30,
    'Acquaintance'
  );
  console.log('flat/low-effort conversation delta:', flat);

  const none = await generateAffectionDelta('hiyori', [], 30, 'Acquaintance');
  console.log('no conversation today delta:', none);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
