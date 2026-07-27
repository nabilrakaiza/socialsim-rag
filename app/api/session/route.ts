import { startNewGame } from '@/lib/orchestrator';
import { fail, ok } from '../_shared';

export async function POST() {
  try {
    return ok(await startNewGame());
  } catch (err) {
    return fail(err);
  }
}
