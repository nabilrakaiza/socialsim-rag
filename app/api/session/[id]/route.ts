import { getGameState } from '@/lib/supabase';
import { fail, ok } from '../../_shared';

// Used to resume after a refresh. The client keeps only the session id, so
// this is how it recovers day/affection/game-over state.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return ok(await getGameState(id));
  } catch (err) {
    // A bad or stale session id is the common case here, not a server fault.
    return fail(err, 404);
  }
}
