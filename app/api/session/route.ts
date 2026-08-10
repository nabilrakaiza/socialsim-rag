import { startNewGame } from '@/lib/orchestrator';
import { UsernameTakenError } from '@/lib/supabase';
import { InvalidUsernameError } from '@/lib/username';
import { fail, ok, readJson } from '../_shared';

interface SessionBody {
  username?: string;
}

export async function POST(request: Request) {
  try {
    const body = await readJson<SessionBody>(request);
    return ok(await startNewGame(body.username ?? ''));
  } catch (err) {
    // Both of these are the player's to fix, not faults — a 409 for a name
    // someone else holds, 400 for one that was never valid. The client shows
    // either against the field rather than as a page-level error, so they need
    // to be distinguishable from a genuine 500.
    if (err instanceof UsernameTakenError) {
      return new Response(JSON.stringify({ error: err.message, field: 'username' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (err instanceof InvalidUsernameError) {
      return new Response(JSON.stringify({ error: err.message, field: 'username' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fail(err);
  }
}
