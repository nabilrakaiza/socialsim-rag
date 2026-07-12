// ============================================================
// scripts/test-retrieval.ts
//
// Manual retrieval smoke test — run after scripts/ingest.ts has
// populated lore_chunks. Embeds a sample query and prints back
// the top matches, so you can sanity-check retrieval quality
// before wiring up any frontend/Gemma integration.
//
// Run with: npm run test-retrieval
// (or: npx tsx scripts/test-retrieval.ts "your query here")
// ============================================================

import 'dotenv/config'; // same ordering requirement as ingest.ts — must come first

import { embedText } from '../lib/embeddings.js';
import { matchLoreChunks } from '../lib/supabase.js';

// argv[0] is the node binary, argv[1] this script's path, so argv[2] is the first CLI arg
const query = process.argv[2] ?? 'does she has a boyfriend before, and how was it?';

async function main() {
  const queryEmbedding = await embedText(query);
  const result = await matchLoreChunks(queryEmbedding, 'hiyori', 5, 0.5);

  result.forEach((f) => {
    console.log(f.content);
    console.log(f.similarity);
    console.log(f.source_file);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
