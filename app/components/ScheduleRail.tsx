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

// The schedule is the day's scarcity, so it stays visible the whole time —
// the player should always be able to see what's left rather than discovering
// the day ended. Segments are shown proportionally to their real duration,
// which makes an unusually long afternoon legible at a glance.
export function ScheduleRail({
  schedule,
  currentIndex,
  inGameHour,
}: {
  schedule: ScheduleSegment[];
  currentIndex: number;
  inGameHour: number;
}) {
  const dayProgress = Math.min(inGameHour / 24, 1);

  return (
    <div className="space-y-2">
      <div className="relative h-2 overflow-hidden rounded-full bg-line">
        <div className="absolute inset-0 flex">
          {schedule.map((segment, i) => (
            <div
              key={segment.name}
              style={{ width: `${(segment.durationHours / 24) * 100}%` }}
              className={
                segment.type === 'free'
                  ? 'border-r border-canvas/40 bg-accent/30'
                  : segment.type === 'activity'
                    ? 'border-r border-canvas/40 bg-muted/25'
                    : 'border-r border-canvas/40 bg-transparent'
              }
              title={`${LABELS[segment.name] ?? segment.name} · ${segment.type}`}
              aria-hidden={i > 0 || undefined}
            />
          ))}
        </div>
        {/* Current position, not a fill bar — the day moves in jumps as well as
            in real time, so a marker reads more honestly than a progress fill. */}
        <motion.div
          className="absolute top-0 h-full w-0.5 bg-accent"
          animate={{ left: `${dayProgress * 100}%` }}
          transition={{ type: 'tween', duration: 0.3, ease: 'easeOut' }}
        />
      </div>

      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {schedule.map((segment, i) => {
          const isCurrent = i === currentIndex;
          const isPast = i < currentIndex;
          return (
            <li
              key={segment.name}
              className={
                isCurrent
                  ? 'font-medium text-accent'
                  : isPast
                    ? 'text-muted/45 line-through decoration-muted/30'
                    : segment.type === 'locked'
                      ? 'text-muted/50'
                      : ''
              }
            >
              {formatGameTime(segment.startHour)} {LABELS[segment.name] ?? segment.name}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
