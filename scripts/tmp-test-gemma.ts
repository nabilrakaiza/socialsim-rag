// Throwaway script to inspect real generateDialogue() output against
// the live API — not part of the real game loop. Safe to delete once
// the actual chat/game-loop integration exists.

import 'dotenv/config';

import { embedText } from '../lib/embeddings';
import { matchLoreChunks } from '../lib/supabase';
import { generateDialogue } from '../lib/gemma';

const playerMessage = 'hey, what did you get up to this weekend?';

async function main() {
  const queryEmbedding = await embedText(playerMessage);
  const chunks = await matchLoreChunks(queryEmbedding, 'hiyori', null, 5, 0.5);

  console.log(`retrieved ${chunks.length} chunks:`);
  chunks.forEach((c) => console.log(`  - (${c.similarity.toFixed(3)}) ${c.source_file}`));

  const result = await generateDialogue(
    'hiyori',
    playerMessage,
    chunks,
    [],
    'Stranger',
    { day: 1, inGameHour: 12.5, activity: 'lunch' }
  );

  console.log('\ngemma result:');
  console.log(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
