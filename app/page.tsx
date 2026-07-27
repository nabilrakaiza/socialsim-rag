'use client';

// The game. Walks the day's schedule segment by segment: `free` segments run
// the clock in real time and open chat, `activity` segments present whatever
// fired there, and `locked` segments are skipped past by the clock hook.
//
// Type-only imports from lib/ are erased at compile time, so no server code
// and no credentials reach the client bundle.

import { useCallback, useEffect, useState } from 'react';
import type { DayPlan, EndDayResult, EndDayStage, ResolvedSegment } from '@/lib/orchestrator';
import type { GameState } from '@/lib/supabase';
import type { NPCCharacter } from '@/lib/gemma';
import type { RelationshipStage } from '@/lib/relationship';
import { formatDuration, formatGameTime, useDayClock } from './useDayClock';
import { ScheduleRail } from './components/ScheduleRail';
import { ChatPanel, type ChatLine } from './components/ChatPanel';
import { SegmentStage } from './components/SegmentStage';
import { DayEnd, type DayRecapEntry } from './components/DayEnd';
import { EndingScreen } from './components/EndingScreen';

const SESSION_KEY = 'socialsim-session-id';

// Semantic stage ids come from lib/; the wording is the UI's business.
const STAGE_COPY: Record<EndDayStage, string> = {
  scoring: 'weighing what you did today…',
  reflecting: 'they’re thinking about you…',
  diary: 'Hiyori is writing in her diary…',
  saving: 'wrapping up…',
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `request failed: ${res.status}`);
  return json as T;
}

// End of day streams newline-delimited JSON so its ~90s of work reports real
// progress. Chunk boundaries can land mid-line, hence the buffer.
async function streamEndDay(sessionId: string, onStage: (stage: EndDayStage) => void): Promise<EndDayResult> {
  const res = await fetch('/api/day/end', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.body) throw new Error('no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: EndDayResult | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line) as { stage?: EndDayStage; result?: EndDayResult; error?: string };
      if (payload.error) throw new Error(payload.error);
      if (payload.stage) onStage(payload.stage);
      if (payload.result) result = payload.result;
    }
  }

  if (!result) throw new Error('end of day finished without a result');
  return result;
}

export default function Page() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [character, setCharacter] = useState<NPCCharacter>('hiyori');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [replyPending, setReplyPending] = useState(false);

  const [answered, setAnswered] = useState<Record<string, boolean>>({});
  const [savingAnswer, setSavingAnswer] = useState(false);

  const [endResult, setEndResult] = useState<EndDayResult | null>(null);
  const [endProgress, setEndProgress] = useState<string | null>(null);
  const [endingDay, setEndingDay] = useState(false);

  const clock = useDayClock(plan?.schedule ?? null);
  const { advance } = clock;

  // Resume on load — the session id is all the client keeps.
  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return;
    setSessionId(stored);
    api<GameState>(`/api/session/${stored}`)
      .then(setState)
      .catch(() => {
        localStorage.removeItem(SESSION_KEY);
        setSessionId(null);
      });
  }, []);

  const guard = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const newGame = () =>
    guard(async () => {
      setLoading(true);
      try {
        const created = await api<GameState>('/api/session', {});
        localStorage.setItem(SESSION_KEY, created.session_id);
        setSessionId(created.session_id);
        setState(created);
        setPlan(null);
        setLines([]);
        setAnswered({});
        setEndResult(null);
      } finally {
        setLoading(false);
      }
    });

  const beginDay = () =>
    guard(async () => {
      setLoading(true);
      try {
        setEndResult(null);
        setEndProgress(null);
        setLines([]);
        setAnswered({});
        setPlan(await api<DayPlan>('/api/day/start', { sessionId }));
      } finally {
        setLoading(false);
      }
    });

  const send = useCallback(
    (text: string) =>
      guard(async () => {
      if (!state) return;
      const stamp = `${Date.now()}`;
      setLines((prev) => [...prev, { id: `p-${stamp}`, character, role: 'player', content: text }]);
      setReplyPending(true);
      try {
        const { reply } = await api<{ reply: string }>('/api/chat', {
          sessionId,
          character,
          day: state.current_day,
          relationshipStage: state.relationship_stage as RelationshipStage,
          playerMessage: text,
        });
        setLines((prev) => [...prev, { id: `n-${stamp}`, character, role: 'npc', content: reply }]);
      } finally {
        setReplyPending(false);
      }
    }),
    [state, character, sessionId]
  );

  const answerEvent = useCallback(
    (resolved: ResolvedSegment, text: string) =>
      guard(async () => {
        setSavingAnswer(true);
        try {
          await api('/api/event/respond', { eventLogId: resolved.eventLogId, playerAction: text });
          setAnswered((prev) => ({ ...prev, [resolved.eventLogId!]: true }));
          advance();
        } finally {
          setSavingAnswer(false);
        }
      }),
    [advance]
  );

  const finishDay = useCallback(
    () =>
      guard(async () => {
        if (!sessionId) return;
        setEndingDay(true);
        setEndProgress(STAGE_COPY.scoring);
        try {
          const result = await streamEndDay(sessionId, (stage) => setEndProgress(STAGE_COPY[stage]));
          setEndResult(result);
          setState(await api<GameState>(`/api/session/${sessionId}`));
        } finally {
          setEndProgress(null);
        }
      }),
    [sessionId]
  );

  // The day's segments have run out — settle it. Guarded on endingDay so the
  // effect can't fire the (expensive, ~90s) end-of-day twice.
  useEffect(() => {
    if (plan && clock.done && !endingDay) void finishDay();
  }, [plan, clock.done, endingDay, finishDay]);

  const confess = () =>
    guard(async () => {
      setLoading(true);
      try {
        await api<{ ending: string }>('/api/confess', { sessionId });
        setState(await api<GameState>(`/api/session/${sessionId}`));
        setPlan(null);
      } finally {
        setLoading(false);
      }
    });

  const currentSegmentName = clock.segment?.name;
  const handleAnswer = useCallback(
    (text: string) => {
      const resolved = plan?.segments.find((s) => s.segment === currentSegmentName);
      if (resolved) void answerEvent(resolved, text);
    },
    [plan, currentSegmentName, answerEvent]
  );

  // ---- render ----

  if (state?.game_over && state.ending_id) {
    return (
      <main className="mx-auto max-w-3xl px-6">
        <EndingScreen
          endingId={state.ending_id}
          onRestart={() => {
            localStorage.removeItem(SESSION_KEY);
            setSessionId(null);
            setState(null);
            setPlan(null);
            setEndResult(null);
          }}
        />
      </main>
    );
  }

  if (!sessionId || !state) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="font-serif text-4xl">social-sim-rag</h1>
        <p className="mt-3 leading-relaxed text-muted">
          Thirty days. Three people who only know what they’ve seen for themselves. No score, no
          meter — just how they talk to you.
        </p>
        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
        <button
          onClick={newGame}
          disabled={loading}
          className="mt-8 self-start rounded-lg bg-accent px-5 py-2 text-sm text-white disabled:opacity-40"
        >
          {loading ? 'Starting…' : 'Begin'}
        </button>
      </main>
    );
  }

  const currentResolved = plan?.segments.find((s) => s.segment === clock.segment?.name);
  const recap: DayRecapEntry[] = (plan?.segments ?? [])
    .filter((s) => s.eventLogId)
    .map((s) => ({
      title: s.subEvent?.description ?? s.event?.description ?? '',
      answered: Boolean(answered[s.eventLogId!]),
    }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="flex items-baseline justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted">Day {state.current_day} of 30</p>
          <p className="font-mono text-3xl tabular-nums">{formatGameTime(clock.inGameHour)}</p>
        </div>
        {plan && !clock.done && (
          <button
            onClick={confess}
            className="text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            confess
          </button>
        )}
      </header>

      {plan && (
        <div className="mt-6">
          <ScheduleRail schedule={plan.schedule} currentIndex={clock.index} inGameHour={clock.inGameHour} />
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {/* Deliberately NOT wrapped in AnimatePresence. The clock re-renders this
          subtree four times a second, and an AnimatePresence with mode="wait"
          restarts its enter animation on every one of those renders — the panel
          never finishes fading in and sits permanently at partial opacity.
          A keyed motion.div still animates on mount, which is all that's wanted
          here: transitions between segments, not on every tick. */}
      <div className="mt-8">
        <>
          {!plan && (
            <div key="idle">
              <button
                onClick={beginDay}
                disabled={loading}
                className="rounded-lg bg-accent px-5 py-2 text-sm text-white disabled:opacity-40"
              >
                {loading ? 'Waking up…' : `Begin day ${state.current_day}`}
              </button>
            </div>
          )}

          {plan && clock.done && (
            <div key="dayend">
              <DayEnd
                day={plan.day}
                recap={recap}
                result={endResult}
                progress={endProgress}
                onContinue={() => {
                  setPlan(null);
                  setEndingDay(false);
                }}
              />
            </div>
          )}

          {plan && !clock.done && clock.segment?.type === 'free' && (
            <div key={`free-${clock.index}`}>
              <div className="mb-3 flex items-center justify-between text-sm">
                <span className="text-muted">
                  Free time — {clock.remainingRealMs !== null && formatDuration(clock.remainingRealMs)} left
                </span>
                <button onClick={advance} className="text-muted underline-offset-4 hover:text-accent hover:underline">
                  skip ahead
                </button>
              </div>
              <div className="h-[26rem] rounded-xl border border-line bg-canvas p-4">
                <ChatPanel
                  lines={lines}
                  character={character}
                  onCharacterChange={setCharacter}
                  onSend={send}
                  pending={replyPending}
                  disabled={clock.expired}
                  disabledReason="Time’s up — you need to get going."
                />
              </div>
              {clock.expired && (
                <button
                  onClick={advance}
                  className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm text-white"
                >
                  Move on
                </button>
              )}
            </div>
          )}

          {plan && !clock.done && clock.segment?.type === 'activity' && currentResolved && (
            <div key={`act-${clock.index}`}>
              <SegmentStage
                resolved={currentResolved}
                saving={savingAnswer}
                onAnswer={handleAnswer}
                onSkip={advance}
              />
            </div>
          )}
        </>
      </div>
    </main>
  );
}
