import { pingDatabase } from '@/lib/supabase';
import { fail, ok } from '../../_shared';

// Keeps the Supabase project awake. A free project is paused after seven days
// with no activity, and once paused the whole game is down until someone
// resumes it by hand in the dashboard. Vercel calls this once a day on the
// schedule in vercel.json, so nobody has to remember to visit the site.
//
// Daily rather than weekly on purpose: a weekly ping that fails once has
// already missed the window.
//
// The pg_cron job that deletes stale sessions runs inside the database every
// night, but that doesn't appear to count — the activity that matters is a
// request arriving from outside, which is why this goes through the API.

// Never cached or prerendered: a cached response would report ok without
// touching the database, which is the one thing this route exists to do.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // When CRON_SECRET is set in the Vercel project, Vercel sends it as a bearer
  // token on every cron call and anything else is turned away. Left unset the
  // route is open, which is tolerable — it performs one fixed read and returns
  // no data — and better than a forgotten env var silently 401ing every run
  // until the project pauses anyway.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return fail(new Error('unauthorized'), 401);
  }

  try {
    await pingDatabase();
    return ok({ ok: true, at: new Date().toISOString() });
  } catch (err) {
    return fail(err);
  }
}
