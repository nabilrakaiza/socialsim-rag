import { sendPlayerMessage } from '@/lib/chat';
import type { NPCCharacter } from '@/lib/gemma';
import type { RelationshipStage } from '@/lib/relationship';
import { fail, ok, readJson, requireString } from '../_shared';

// One player message in, one NPC reply out. Retrieval plus generation, ~2s
// median on the flash-lite chain — still worth a pending state in the client,
// since the fallback model is considerably slower.
export const maxDuration = 120;

interface ChatBody {
  sessionId?: string;
  character?: NPCCharacter;
  day?: number;
  relationshipStage?: RelationshipStage;
  playerMessage?: string;
  inGameHour?: number;
  activity?: string;
}

export async function POST(request: Request) {
  try {
    const body = await readJson<ChatBody>(request);

    if (typeof body.day !== 'number') {
      throw new Error('missing or invalid field: day');
    }
    if (typeof body.inGameHour !== 'number') {
      throw new Error('missing or invalid field: inGameHour');
    }

    return ok(
      await sendPlayerMessage({
        sessionId: requireString(body.sessionId, 'sessionId'),
        character: requireString(body.character, 'character') as NPCCharacter,
        day: body.day,
        relationshipStage: requireString(body.relationshipStage, 'relationshipStage') as RelationshipStage,
        playerMessage: requireString(body.playerMessage, 'playerMessage'),
        inGameHour: body.inGameHour,
        activity: typeof body.activity === 'string' ? body.activity : undefined,
      })
    );
  } catch (err) {
    return fail(err);
  }
}
