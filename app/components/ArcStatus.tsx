'use client';

import type { GameEvent } from '@/lib/events';

// A persistent reminder that an arc is running, and how far through it is.
//
// The announcement fires once on the opening day; without something standing
// after it, a player returning on day four has no way to tell an arc is still
// active — the sub-events just look like ordinary ones again.
export function ArcStatus({
  arc,
  startDay,
  currentDay,
}: {
  arc: GameEvent;
  startDay: number;
  currentDay: number;
}) {
  // 1-indexed, and clamped: an arc's final beat can resolve on its last day,
  // and showing "day 8 of 7" for that would read as a bug.
  const dayInArc = Math.min(currentDay - startDay + 1, arc.duration_days);
  const isFinalDay = dayInArc >= arc.duration_days;

  return (
    <div className="mt-3 rounded-[10px] border border-line bg-card/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-mint" aria-hidden />
        <span className="truncate font-mono text-[0.7rem] text-ink" title={arc.title}>
          {arc.title}
        </span>
      </div>
      <p className="mt-1 pl-3.5 font-mono text-[0.7rem] text-muted">
        day <span className="text-mint">{dayInArc}</span> of {arc.duration_days}
        {isFinalDay && <span className="text-mint"> · last day</span>}
      </p>
    </div>
  );
}
