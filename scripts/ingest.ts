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
import { chunkLoreFile, LoreChunk } from '../lib/chunking.js';
import { embedText } from '../lib/embeddings.js';
import { insertLoreChunks } from '../lib/supabase.js';

const LORE_DIR = join(process.cwd(), 'lore');

async function main() {
  // HINT: readdirSync(LORE_DIR) lists every file in lore/ —
  // that includes diary_system.md (a spec doc, not lore to
  // embed) and possibly .DS_Store on macOS. Filter to just the
  // 7 real lore files (5 section-style .txt, 1 diary .txt, 1
  // events.json) before processing.
  //
  // HINT: for each file:
  //   1. read its raw text (readFileSync(path, 'utf-8'))
  //   2. chunkLoreFile(path, rawText) -> LoreChunk[]
  //   3. lib/supabase.ts has no section_title column, so
  //      section_title would otherwise just be dropped on
  //      insert — fold it into content instead, here, before
  //      embedding: something like
  //      `chunk.section_title ? \`${chunk.section_title}\n\n${chunk.content}\` : chunk.content`.
  //      Build this as a new array of chunks with `content`
  //      replaced by that merged string (spread the rest of each
  //      chunk unchanged) — that merged content is then what gets
  //      both embedded AND stored, so retrieval results carry the
  //      section context too.
  //   4. embed each (merged) chunk's `content` with embedText — a
  //      plain sequential loop (await one at a time) is the safer
  //      starting point vs. Promise.all, since a free-tier API
  //      likely has a requests-per-minute limit you could blow
  //      through with full concurrency across ~30-40 chunks.
  //   5. insertLoreChunks(chunks, embeddings) once you have both
  //      arrays for that file (or batch across all files — your
  //      call, but the arrays need to stay in matching order).
  //
  // HINT: console.log as you go (which file, how many chunks,
  // maybe a running total) — this will take a little while given
  // ~30-40 sequential API calls, and silent output makes it hard
  // to tell if it's working or just hanging.

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
  console.log(`Inserted ${allChunks.length} chunks into lore_chunks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
