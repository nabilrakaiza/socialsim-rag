// Shared helpers for the route handlers.
//
// Everything under app/api runs server-side only. That is the whole point of
// this boundary: lib/supabase.ts holds SERVICE_ROLE (which bypasses row-level
// security) and lib/gemma.ts holds GOOGLE_API_KEY. Neither may ever be
// imported from a client component, so the browser only ever talks to these
// routes over fetch.

import { NextResponse } from 'next/server';

export function ok<T>(data: T) {
  return NextResponse.json(data);
}

// Error text is passed through deliberately — this is a single-player game
// with no accounts and nothing sensitive in these messages, and a readable
// failure is far more useful than a generic 500 while building.
export function fail(err: unknown, status = 500) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
  return NextResponse.json({ error: message }, { status });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('request body was not valid JSON');
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing or empty field: ${field}`);
  }
  return value;
}
