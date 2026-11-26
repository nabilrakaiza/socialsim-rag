// ============================================================
// lib/env.ts
//
// Read a required environment variable, or fail with an error that
// says how to fix it. Without this, a missing .env surfaces as
// "supabaseKey is required" from deep inside supabase-js, which
// doesn't point at the cause.
// ============================================================

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}: copy .env.example to .env and fill it in (see README Quick start).`
    );
  }
  return value;
}
