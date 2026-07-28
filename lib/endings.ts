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
// Two notes on events.json's trigger text:
//
//  - bad_end is purely the low-affection confession: the player shoots their
//    shot before she's anywhere near ready, and she turns him down. The
//    trigger text also says "or multiple wrong moves accumulate", but that's
//    describing why affection ended up low, not a second mechanic — there is
//    no wrong-move counter and there isn't meant to be one.
//
//  - Settled: secret_end's timing was left open by its trigger text, which
//    says "Yuki's affection >= 70 and the player never confessed to
//    Hiyori" without saying when that's checked. It's day 30 only.
//    It's the alternative to letting the clock run out, not something
//    that can cut the run short the moment Yuki's meter crosses 70.
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
