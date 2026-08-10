import { getGameStateByUsername } from '@/lib/supabase';
import { InvalidUsernameError, normalizeUsername } from '@/lib/username';
import { fail, ok, readJson } from '../../_shared';

// Finding a save again from the name the player chose. The only route that
// takes a username without a session id — everything else already has one.
//
// No rate limiting, deliberately: a username is an identifier rather than a
// secret (see lib/username.ts), so there is nothing here that guessing would
// obtain that the design doesn't already grant.
export async function POST(request: Request) {
  try {
    const body = await readJson<{ username?: string }>(request);
    const state = await getGameStateByUsername(normalizeUsername(body.username));

    if (!state) {
      return new Response(JSON.stringify({ error: 'no save under that name', field: 'username' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return ok(state);
  } catch (err) {
    if (err instanceof InvalidUsernameError) {
      return new Response(JSON.stringify({ error: err.message, field: 'username' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fail(err);
  }
}
