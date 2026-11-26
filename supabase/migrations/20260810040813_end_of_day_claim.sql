-- ============================================================
-- Make end-of-day scoring claimable, so a day can only be scored once.
--
-- Why: useDayClock called onDayComplete from inside a state updater, React
-- invoked it twice under Strict Mode, and a real playthrough's day 1 was
-- scored twice — 8 dynamic chunks and 2 diary entries where one run writes at
-- most 4 and exactly 1. Worse than duplication: the two runs interpreted the
-- same day differently, so every character ended up holding contradictory
-- memories of it, and affection was applied twice with no record of each run's
-- contribution, so the save could not be repaired.
--
-- That bug is fixed on the client, but the client is the wrong place for this
-- to be enforced. endDay is minutes of LLM work and is NOT idempotent; a
-- double-click, a retry, or a second tab can still call it twice. startDay
-- already guards against a refresh corrupting the day. This is the symmetric
-- guard for the more destructive direction.
-- ============================================================

alter table public.game_state
  add column if not exists scoring_day integer;

comment on column public.game_state.scoring_day is
  'Day currently being (or most recently) scored by endDay. Set atomically by claim_day_for_scoring; cleared by release_day_scoring_claim when a run fails.';

-- Claims the current day for scoring, atomically.
--
-- Returns the day on success, NULL when it is already claimed.
--
-- The conditional UPDATE is what makes this safe, not the read before it. Two
-- concurrent calls both reach the UPDATE; Postgres serialises them on the row
-- lock, and under READ COMMITTED the loser re-evaluates its WHERE against the
-- winner's committed row (EvalPlanQual), sees scoring_day = current_day, and
-- matches zero rows. A read-then-write in application code would not have that
-- property.
create or replace function public.claim_day_for_scoring(p_session_id text)
returns integer
language plpgsql
as $$
declare
  claimed integer;
begin
  update public.game_state
     set scoring_day = current_day
   where session_id = p_session_id
     -- `is distinct from` rather than `<>`: scoring_day is NULL before the
     -- first ever end-of-day, and NULL <> 1 is NULL, not true, so a plain
     -- inequality would refuse to claim the very first day.
     and scoring_day is distinct from current_day
  returning current_day into claimed;

  return claimed;
end;
$$;

-- Releases the claim so the day can be scored again.
--
-- Called only on failure. End of day is retryable by design — a failed run
-- leaves the day unadvanced and the player can try again — and holding the
-- claim through a failure would turn a transient model error into a session
-- that can never progress.
create or replace function public.release_day_scoring_claim(p_session_id text)
returns void
language sql
as $$
  update public.game_state
     set scoring_day = null
   where session_id = p_session_id;
$$;
