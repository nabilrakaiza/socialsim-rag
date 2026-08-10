-- ============================================================
-- Let a save be found again from a name the player chose.
--
-- Until now a save was reachable only through the session_id in localStorage.
-- Clear the browser, switch from laptop to phone, or open it in a private
-- window and the run is unreachable — the row lives on in Supabase for thirty
-- days but nothing can look it up.
--
-- A username, deliberately NOT a password. It is an identifier, not a secret:
-- anyone who guesses a name can load that run, and because continuing a run
-- can end it (confess is permanent), a guessed name can destroy someone's
-- playthrough. That trade is accepted for a hobby project with a nicer
-- one-field flow; it is written down here so the next person doesn't mistake
-- this for authentication and build something on top of it that needs to be.
-- ============================================================

alter table public.game_state
  add column if not exists username text;

comment on column public.game_state.username is
  'Player-chosen save name. An identifier, NOT a secret — anyone who guesses it can load and end that run. Unique case-insensitively; null for sessions created before this existed.';

-- Case-insensitive, so "Nabil" and "nabil" cannot both be claimed and a player
-- who capitalises differently on their return still finds their save.
--
-- Postgres excludes nulls from unique indexes, so every pre-existing session
-- keeps its null without colliding.
create unique index if not exists game_state_username_unique
  on public.game_state (lower(username));
