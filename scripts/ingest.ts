// ============================================================
// scripts/ingest.ts
//
// Orchestrates the full static-lore ingestion pipeline:
// read each lore file -> chunk it -> embed each chunk ->
// insert into Supabase.
//
// Run with: npm run ingest
// ============================================================

// MUST be the first import — embeddings.ts and supabase.ts both
// read process.env at module load time (when they're imported),
// not lazily when their functions are called. If dotenv hasn't
// loaded .env into process.env yet by the time those modules are
// first imported below, GOOGLE_API_KEY/SUPABASE_URL/SERVICE_ROLE
// will all be empty strings.
import 'dotenv/config';

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { chunkLoreFile, LoreChunk } from '../lib/chunking';
import { embedText } from '../lib/embeddings';
import { deleteStaticLoreChunks, insertLoreChunks } from '../lib/supabase';

const LORE_DIR = join(process.cwd(), 'lore');

async function main() {
  // Clear before inserting, so this is idempotent. Without it a second run
  // duplicates every chunk rather than refreshing it, which is why the events
  // content sat stale for days — re-running to pick up new events would have
  // doubled the other five files.
  const removed = await deleteStaticLoreChunks();
  console.log(`cleared ${removed} existing static chunks (dynamic per-session chunks untouched)`);

  const files = readdirSync(LORE_DIR);
  const loreFiles = files.filter((f) => {
    return f.endsWith(".json") || f.endsWith(".txt");
  });

  const chunkedFiles: LoreChunk[][] = loreFiles.map((f) => chunkLoreFile(join(LORE_DIR, f), readFileSync(join(LORE_DIR, f), 'utf-8')));

  const mergedChunks: LoreChunk[][] = chunkedFiles.map((f) =>
    f.map((g) => ({
      ...g,
      content: g.section_title ? `${g.section_title}\n\n${g.content}` : g.content,
    }))
  );

  const allChunks = mergedChunks.flat();

  const embeddings: number[][] = [];

  for (const [i, chunk] of allChunks.entries()) {
    const embedding = await embedText(chunk.content);
    embeddings.push(embedding);
    console.log(`[${i + 1}/${allChunks.length}] embedded ${chunk.source_file} (chunk ${chunk.chunk_index})`);
  }

  await insertLoreChunks(allChunks, embeddings);

  const byCharacter = allChunks.reduce<Record<string, number>>((acc, chunk) => {
    acc[chunk.character] = (acc[chunk.character] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nInserted ${allChunks.length} chunks:`, byCharacter);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
