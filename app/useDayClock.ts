'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScheduleSegment } from '@/lib/schedule';

// The compression rate from the design: one in-game hour costs this many real
// minutes, and only while a `free` segment is running. A ~1h lunch is therefore
// ~15 real minutes of actual chatting.
export const REAL_MINUTES_PER_GAME_HOUR = 15;

const MS_PER_GAME_HOUR = REAL_MINUTES_PER_GAME_HOUR * 60 * 1000;

export function formatGameTime(hoursSinceMidnight: number): string {
  const totalMinutes = Math.floor(hoursSinceMidnight * 60) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// `locked` segments are sleep — nothing happens and nothing is shown, so the
// clock jumps straight past them rather than making the player sit through
// eight hours of night at any compression rate. Skipping them here, rather
// than auto-advancing from an effect, avoids a state-update loop.
function nextPlayableIndex(schedule: ScheduleSegment[], from: number): number {
  let i = from;
  while (i < schedule.length && schedule[i].type === 'locked') i++;
  return i;
}

export interface DayClock {
  segment: ScheduleSegment | null;
  index: number;
  /** Hours since midnight, advancing in real time inside `free` segments. */
  inGameHour: number;
  /** Real milliseconds left in this segment; null outside `free` segments. */
  remainingRealMs: number | null;
  /** True once a free segment has run its full length. */
  expired: boolean;
  /** No segments left — the day is over. */
  done: boolean;
  advance: () => void;
}

export function useDayClock(schedule: ScheduleSegment[] | null): DayClock {
  const [index, setIndex] = useState(0);
  const [elapsedHours, setElapsedHours] = useState(0);

  // Reset to the first playable segment whenever a new day's schedule arrives.
  useEffect(() => {
    if (!schedule) return;
    setIndex(nextPlayableIndex(schedule, 0));
    setElapsedHours(0);
  }, [schedule]);

  const segment = schedule && index < schedule.length ? schedule[index] : null;
  const isFree = segment?.type === 'free';

  // Only free segments consume real time. The interval is keyed on the segment
  // itself, so switching segments restarts the measurement cleanly.
  useEffect(() => {
    if (!segment || !isFree) return;

    const startedAt = Date.now();
    const tick = () => {
      const gameHours = (Date.now() - startedAt) / MS_PER_GAME_HOUR;
      setElapsedHours(Math.min(gameHours, segment.durationHours));
    };

    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [segment, isFree]);

  const advance = useCallback(() => {
    if (!schedule) return;
    setElapsedHours(0);
    setIndex((current) => nextPlayableIndex(schedule, current + 1));
  }, [schedule]);

  return useMemo(() => {
    const inGameHour = segment ? segment.startHour + elapsedHours : 24;
    const remainingRealMs = isFree && segment ? (segment.durationHours - elapsedHours) * MS_PER_GAME_HOUR : null;

    return {
      segment,
      index,
      inGameHour,
      remainingRealMs,
      expired: Boolean(isFree && segment && elapsedHours >= segment.durationHours),
      done: Boolean(schedule) && !segment,
      advance,
    };
  }, [schedule, segment, isFree, index, elapsedHours, advance]);
}
