// ============================================================
// lib/embeddings.ts
//
// Wraps Google's gemini-embedding-001 model, truncated to 768
// dims (via outputDimensionality) to match the lore_chunks
// pgvector schema. text-embedding-004 (the original plan) was
// shut down by Google on 2026-01-14 — this replaces it.
// ============================================================

import { GoogleGenAI } from '@google/genai';

// reads GOOGLE_API_KEY from process.env — dotenv's config() must
// run before this module is imported (scripts/ingest.ts does this)
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' });

export async function embedText(text: string): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: 'gemini-embedding-001',
    contents: text,
    config: { outputDimensionality: 768 },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values) {
    throw new Error('embedContent returned no embedding values');
  }

  return values;
}

// NOTE: you'll be calling this once per chunk (~30-40 times) in
// scripts/ingest.ts. A simple loop calling embedText repeatedly
// is fine to start with — only worry about batching (the SDK may
// have a batchEmbedContents-style method) if it turns out to be
// too slow or you hit a rate limit.
