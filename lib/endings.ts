// ============================================================
// lib/endings.ts
//
// Decides which of the five endings a playthrough has reached, if
// any. Pure and deterministic — same reasoning as lib/relationship.ts:
// these are exact numeric rules straight out of events.json's
// `endings` block, not something worth spending a Gemma call (or
// risking hallucinated judgment) on. The ending's *prose* lives in
// events.json; this only picks the id.
//
// Two things in events.json's trigger text are NOT implemented here,
// deliberately, because they aren't defined anywhere yet:
//
//  - bad_end's "or multiple wrong moves accumulate". There is no
//    wrong-move counter in game_state and no definition of what
//    counts as one, so only the affection-based path is implemented.
//    Adding it later means a new counter column plus a threshold.
//
//  - secret_end's timing. Its trigger only says "Yuki's affection
//    >= 70 and the player never confessed to Hiyori", never when it
//    is checked. Evaluated here at the end of the run alongside
//    too_late_end, so it reads as the alternative to letting the
//    clock run out rather than something that cuts the game short
//    the moment Yuki's meter crosses 70. If it should instead be
//    able to fire mid-game, move it above the day check below.
// ============================================================

export type EndingId =
  | 'good_end'
  | 'friend_zone_end'
  | 'bad_end'
  | 'too_late_end'
  | 'secret_end';

export const TOTAL_GAME_DAYS = 30;

export interface EndingCheckInput {
  currentDay: number;
  affection: number;
  yukiAffection: number;
  confessed: boolean;
}

// Returns null while the game is still running. Confession resolves
// immediately whenever it happens; everything else waits for the clock.
export function checkEnding(input: EndingCheckInput): EndingId | null {
  // Confession is never gated by affection — the player can shoot their
  // shot at any point, for better or worse. The score only decides how
  // it lands.
  if (input.confessed) {
    if (input.affection >= 80) {
      return 'good_end';
    }
    if (input.affection >= 40) {
      return 'friend_zone_end';
    }
    return 'bad_end';
  }

  if (input.currentDay < TOTAL_GAME_DAYS) {
    return null;
  }

  // Out of days without confessing. Yuki's route is the one way this
  // doesn't end in the door closing on its own.
  if (input.yukiAffection >= 70) {
    return 'secret_end';
  }
  return 'too_late_end';
}
