'use client';

import { motion } from 'motion/react';
import type { ScheduleSegment } from '@/lib/schedule';
import { formatGameTime } from '../useDayClock';

const LABELS: Record<string, string> = {
  sleep_morning: 'Asleep',
  get_ready: 'Getting ready',
  morning_activity: 'Morning',
  lunch: 'Lunch',
  activity_after_lunch: 'Afternoon',
  dinner: 'Dinner',
  activity_after_dinner: 'Evening',
  sleep_night: 'Winding down',
};

// A day column, calendar style: blocks sized by real duration, a time axis
// down the left, and a line marking now.
//
// Height is fixed for the whole 24h rather than fitted to content, so a block's
// size means something — a four-hour afternoon looks four times a one-hour
// lunch. That does spend a lot of the column on sleep, which is the honest
// trade: the day genuinely is mostly sleep, and hiding that would make the
// waking hours look more spacious than they are.
const COLUMN_HEIGHT = 560;
const HOURS_IN_DAY = 24;

function topFor(hour: number) {
  return (hour / HOURS_IN_DAY) * COLUMN_HEIGHT;
}

export function ScheduleRail({
  schedule,
  currentIndex,
  inGameHour,
}: {
  schedule: ScheduleSegment[];
  currentIndex: number;
  inGameHour: number;
}) {
  return (
    <div className="flex gap-3">
      {/* Time axis. Every three hours — hourly would crowd the column at this
          scale and the exact gridline isn't what's being read. */}
      <div className="relative w-10 shrink-0" style={{ height: COLUMN_HEIGHT }}>
        {Array.from({ length: HOURS_IN_DAY / 3 + 1 }, (_, i) => i * 3).map((hour) => (
          <span
            key={hour}
            className="absolute right-0 -translate-y-1/2 font-mono text-[0.65rem] text-muted/60"
            style={{ top: topFor(hour) }}
          >
            {String(hour).padStart(2, '0')}:00
          </span>
        ))}
      </div>

      <div
        className="relative flex-1 overflow-hidden rounded-[10px] border border-line bg-card/40"
        style={{ height: COLUMN_HEIGHT }}
      >
        {Array.from({ length: HOURS_IN_DAY / 3 + 1 }, (_, i) => i * 3).map((hour) => (
          <div
            key={hour}
            className="absolute inset-x-0 border-t border-line/40"
            style={{ top: topFor(hour) }}
            aria-hidden
          />
        ))}

        {schedule.map((segment, i) => {
          const height = (segment.durationHours / HOURS_IN_DAY) * COLUMN_HEIGHT;
          const isCurrent = i === currentIndex;
          const isPast = i < currentIndex;

          // Labels are dropped rather than clipped as blocks get short. A
          // 20-minute get-ready is ~8px tall at this scale, and rendering a
          // full label into it spilled over the block below — the previous
          // version computed this and then ignored it. The tooltip still
          // carries the detail at every size.
          const showName = height >= 30;
          const showTime = height >= 16;

          return (
            <div
              key={segment.name}
              className={`absolute inset-x-1 overflow-hidden rounded border-l-2 px-2 transition-opacity ${
                height >= 30 ? 'py-1' : 'py-0'
              } ${
                segment.type === 'free'
                  ? 'border-l-mint bg-mint/10'
                  : segment.type === 'activity'
                    ? 'border-l-violet bg-violet/10'
                    : 'border-l-muted/30 bg-transparent'
              } ${isCurrent ? 'ring-1 ring-mint/50' : ''} ${isPast ? 'opacity-35' : ''}`}
              style={{ top: topFor(segment.startHour), height: Math.max(height - 2, 12) }}
              title={`${formatGameTime(segment.startHour)} · ${LABELS[segment.name] ?? segment.name}`}
            >
              {showTime && (
                <div className="flex items-baseline gap-2 leading-none">
                  <span
                    className={`font-mono text-[0.7rem] ${
                      isCurrent ? 'font-medium text-mint' : 'text-muted'
                    }`}
                  >
                    {formatGameTime(segment.startHour)}
                  </span>
                  {showName && (
                    <span className={`truncate text-[0.75rem] ${isCurrent ? 'text-ink' : 'text-muted'}`}>
                      {LABELS[segment.name] ?? segment.name}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Now. A line rather than a fill, because the day advances in jumps as
            well as in real time and a filled bar would imply steady progress. */}
        <motion.div
          className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
          animate={{ top: topFor(Math.min(inGameHour, HOURS_IN_DAY)) }}
          transition={{ type: 'tween', duration: 0.3, ease: 'easeOut' }}
        >
          <span className="h-2 w-2 -translate-x-1/2 rounded-full bg-mint" />
          <span className="h-px flex-1 bg-mint/70" />
        </motion.div>
      </div>
    </div>
  );
}
