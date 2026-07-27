// Throwaway script to check generateKnowledgeUpdate and generateDiaryEntry
// against the live API. Not part of the real pipeline — safe to delete
// once the batch-eval orchestrator exists and exercises these for real.

import 'dotenv/config';

import { generateKnowledgeUpdate, generateDiaryEntry } from '../lib/gemma';
import { tierLabel } from '../lib/relationship';

async function main() {
  const knowledge = await generateKnowledgeUpdate('hiyori', [
    { role: 'player', content: "hey, saw you at the library yesterday, didn't want to interrupt since you looked deep in that lab report" },
    { role: 'npc', content: "...you noticed that? it was due today, I was dying." },
    { role: 'player', content: "how'd it go? you looked stressed" },
    { role: 'npc', content: "fine. i mean, it's done. thanks for asking I guess." },
  ]);
  console.log('generateKnowledgeUpdate:\n', knowledge.content, '\n');

  const emptyKnowledge = await generateKnowledgeUpdate('shiori', []);
  console.log('generateKnowledgeUpdate (no interaction):\n', emptyKnowledge.content, '\n');

  const diary = await generateDiaryEntry({
    day: 6,
    tierLabel: tierLabel(2),
    relationshipStage: 'Acquaintance',
    eventSummary: 'Ran into Adrian at the library while finishing a lab report.',
    adrianAction: 'Noticed she looked stressed and asked how the lab report went, without making a big deal of it.',
    lastEntries: [
      '[Day 1 — In-game] Orientation committee meeting, three hours. Adrian was there. Color-coded notes, apparently. Fine.',
    ],
  });
  console.log('generateDiaryEntry:\n', diary.entry);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
