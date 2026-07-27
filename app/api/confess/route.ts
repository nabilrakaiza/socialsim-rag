import { confess } from '@/lib/orchestrator';
import { fail, ok, readJson, requireString } from '../_shared';

export async function POST(request: Request) {
  try {
    const body = await readJson<{ sessionId?: string }>(request);
    const ending = await confess(requireString(body.sessionId, 'sessionId'));
    return ok({ ending });
  } catch (err) {
    return fail(err);
  }
}
