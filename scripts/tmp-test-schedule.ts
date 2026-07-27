// Throwaway script to sanity-check generateDailySchedule's output:
// durations positive, segments sum to 24h, proportions look plausible.
// No DB/API calls — pure function, safe to run repeatedly.

import { generateDailySchedule } from '../lib/schedule';

function formatHour(h: number): string {
  const totalMinutes = Math.round(h * 60) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

for (let day = 1; day <= 5; day++) {
  const schedule = generateDailySchedule();
  const total = schedule.reduce((sum, s) => sum + s.durationHours, 0);
  const anyNegative = schedule.some((s) => s.durationHours <= 0);

  console.log(`\n--- day ${day} (total: ${total.toFixed(4)}h, any non-positive: ${anyNegative}) ---`);
  schedule.forEach((s) => {
    const end = s.startHour + s.durationHours;
    console.log(`${s.name.padEnd(22)} [${s.type.padEnd(8)}] ${formatHour(s.startHour)} - ${formatHour(end)}  (${s.durationHours.toFixed(2)}h)`);
  });
}
