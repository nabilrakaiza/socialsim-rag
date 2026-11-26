-- ============================================================
-- Stop the cleanup job deleting saves that are being actively played.
--
-- `delete-stale-sessions` was written as an inactivity purge — "delete any
-- session idle for 7+ days" — and the schema comment describes it that way.
-- It was not one. game_state.updated_at defaults to now() on insert, there was
-- no trigger maintaining it, and no application code ever wrote it. So the
-- column was really created_at, and the job deleted every session SEVEN DAYS
-- AFTER IT BEGAN, however actively it was being played.
--
-- For a thirty-day game played in real-minute sessions that is the expected
-- path, not an edge case: half an hour a night puts you around day 8 when the
-- run is deleted at 3am, mid-playthrough, with everything cascading — messages,
-- diary entries, events, and the memory each character had formed.
--
-- Two changes, because either alone is insufficient. The trigger makes
-- updated_at mean what it claims. The longer interval gives a real person room
-- to put the game down for a few weeks and come back, which is the whole
-- promise of a resumable save.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Make updated_at honest
-- ------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists game_state_set_updated_at on public.game_state;

create trigger game_state_set_updated_at
  before update on public.game_state
  for each row
  execute function public.set_updated_at();

-- Every write the game makes to a session goes through updateGameState, so
-- this covers ending a day, confessing, and claiming a day for scoring. Chat
-- alone doesn't touch game_state — but a day that had conversation in it ends
-- with a batch eval that writes affection, so any real play advances the clock.

-- Existing rows carry an updated_at from whenever they were inserted, which
-- for a live save understates its real activity. Bumped once here so the
-- retention window starts fresh rather than deleting a current playthrough on
-- the strength of a column that was never maintained.
update public.game_state set updated_at = now() where not game_over;

-- ------------------------------------------------------------
-- 2. Widen the window
-- ------------------------------------------------------------
-- 7 days was chosen when the column was assumed to track activity. Now that it
-- genuinely does, the interval means "abandoned for this long", and 30 days is
-- both a fair definition of abandoned and comfortably longer than a full
-- playthrough. Storage is not the constraint at this scale: a finished session
-- is a few dozen rows plus ~30 embeddings, on the order of 100KB, against a
-- 500MB free tier.
select cron.unschedule('delete-stale-sessions');

select cron.schedule(
  'delete-stale-sessions',
  '0 3 * * *',  -- every day at 3am UTC
  $$
    delete from public.game_state
    where updated_at < now() - interval '30 days';
  $$
);
