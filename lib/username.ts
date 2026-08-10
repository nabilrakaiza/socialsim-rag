// ============================================================
// lib/username.ts
//
// The name a player uses to find their save again.
//
// An identifier, not a secret. Anyone who guesses a name can load that run —
// and because confessing is permanent, they can end it. That is an accepted
// trade for a one-field flow on a hobby project, not an oversight, and it is
// why nothing here hashes or compares in constant time: there is no secret to
// protect.
//
// Validation lives in its own module because both the create and resume paths
// need exactly the same normalisation. If they disagreed, a name could be
// claimable but not findable.
// ============================================================

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 24;

// Letters, digits, space, hyphen, underscore. Unicode letters are allowed —
// there is no reason a player can't call a save 幸 or señor — but control
// characters and punctuation that invites confusion are not.
const ALLOWED = /^[\p{L}\p{N} _-]+$/u;

export class InvalidUsernameError extends Error {}

/**
 * Trims and collapses internal whitespace, then validates.
 *
 * Returns the name as the player should see it stored. Lookups compare
 * case-insensitively (see the unique index in
 * supabase/migrations/0004_username_saves.sql), so casing is preserved for
 * display rather than being flattened here.
 */
export function normalizeUsername(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidUsernameError('pick a name for your save');
  }

  // Collapsed, not just trimmed: "my  save" and "my save" reading as different
  // names is the kind of thing that makes a save impossible to find again.
  const name = raw.trim().replace(/\s+/g, ' ');

  if (name.length === 0) {
    throw new InvalidUsernameError('pick a name for your save');
  }
  if (name.length < USERNAME_MIN) {
    throw new InvalidUsernameError(`at least ${USERNAME_MIN} characters`);
  }
  if (name.length > USERNAME_MAX) {
    throw new InvalidUsernameError(`at most ${USERNAME_MAX} characters`);
  }
  if (!ALLOWED.test(name)) {
    throw new InvalidUsernameError('letters, numbers, spaces, - and _ only');
  }

  return name;
}
