# social-sim-rag

A narrative, RAG-powered dating simulation built as a learning project for retrieval-augmented generation (RAG) architecture. The gameplay is a wrapper — the real point of this project is to design and implement a working RAG pipeline end to end: chunking, embedding, vector storage, retrieval, and grounded LLM generation.

> Working title: `social-sim-rag'

---

## Concept

Adrian (CS, NUS) is introduced to Hiyori (Life Sciences, NUS) through his coursemate Shiori. Over 30 in-game days, the player navigates conversations, random real-life events, and a slowly evolving relationship — all while a hidden affection meter and relationship tier quietly drive how each character responds.

NPC dialogue isn't scripted — it's grounded in per-character lore stored in a vector database. Each character only "knows" what they've personally witnessed or been told directly by Adrian. There's no shared gossip system between NPCs; information flows only through the player's choices.

---

## Characters

| Name | Role | Details |
|---|---|---|
| **Hiyori** | Main love interest | Life Sciences, NUS. Tsundere, cycling club, tutors secondary schoolers. Warms up slowly. |
| **Shiori** | Friend / intel source | CS, NUS. Adrian's coursemate. Direct, protective of Hiyori, won't do the work for Adrian. |
| **Yuki** | Secret route | Economics, NUS. Same secondary school as Adrian. Quiet, unresolved feelings — never surfaces unless the player pays attention to her specifically. |
| **Adrian** | Player character | CS, NUS. No stored knowledge base — he *is* the player. |

---

## Core Systems

### Hidden Affection Meter
A 0–100 score for Hiyori (and a separate hidden meter for Yuki) that is **never shown to the player**. It's inferred only through dialogue tone and NPC behavior, and mapped to 5 tiers used to guide Gemma's writing voice without ever exposing the raw number.

### Relationship Stages
`Stranger → Acquaintance → Friend → Close Friend` — gates which events and dialogue are available.

### Schedule Generation
Each in-game day is 8 sequential segments covering the full 24-hour cycle:

| Segment | Type | Notes |
|---|---|---|
| `sleep_morning` | locked | midnight → wake time (tail end of last night's sleep) |
| `get_ready` | free | |
| `morning_activity` | activity | resolves later to class / homework / group project / free time |
| `lunch` | free | |
| `activity_after_lunch` | activity | resolves later to class / homework / free time |
| `dinner` | free | |
| `activity_after_dinner` | activity | resolves later to homework / free time / gaming |
| `sleep_night` | locked | short (~30min) — just the midnight-to-bedtime tail, not the whole night |

Each segment's duration is drawn from its own normal distribution, then the full set is rescaled so all 8 sum to exactly 24 hours (preserving relative proportions). No fixed action-point count — the schedule itself is the day's scarcity. Implemented in `lib/schedule.ts`'s `generateDailySchedule`.

### Daily Flow
1. Player sees their schedule for the day (the 8 segments above) plus the current in-game clock.
2. During `free` segments (`get_ready`, `lunch`, `dinner`), in-game time runs in real time at a fixed compression rate — **1 in-game hour ≈ 15 real minutes** — while the player can chat with Hiyori, Shiori, or Yuki. A skip action ends the segment immediately and jumps to the next one.
3. `locked` segments (asleep) and unresolved `activity` segments are not interactive — no live waiting; the clock just advances by that segment's full duration and moves to the next segment. **Random events fire unpredictably** during `activity` segments (busy blocks), never during `locked` ones.
4. This live clock/schedule state is deliberately **not persisted server-side** — it only exists as client-side session state once the frontend exists. Exiting mid-day loses that day's progress; only the end-of-day checkpoint below is saved.
5. Confessing is available at any point and ends the run immediately — the affection score only decides which of the three confession endings you get.
6. At end of day, a batch evaluation runs:
   - Updates the hidden affection score and relationship tier
   - Updates each NPC's individual knowledge base (what they know/feel about Adrian, based only on what they personally experienced that day)
   - Generates a new Hiyori diary entry if a trigger condition is met
   - Re-embeds all new dynamic content into the vector store

`lib/orchestrator.ts` is the only module that knows how a day runs, and exposes the four calls a frontend needs: `startDay()` returns the day's plan (schedule plus which events fire in which segment), `recordEventResponse()` persists the player's free-text answer to one event, `confess()` ends the run, and `endDay()` scores the day's events, runs the batch evaluation, and advances the clock. Everything else stays deliberately unaware of the rest: `lib/events.ts` is pure logic that touches no database, `lib/chat.ts` handles a single message, `lib/batch-eval.ts` a single end-of-day.

### Event System
All events live in `lore/events.json` (30 events, 54 sub-events) and are resolved by `lib/events.ts`.

**On a normal day**, each `activity` segment rolls once: 70% chance of an event in the morning and afternoon, 50% at night. The remainder resolves to flavor-only filler (class, homework, gaming, …) that carries no mechanical weight. If the roll lands on "event", the pool is filtered by the segment (each event declares `eligible_segments`), the player's relationship stage, and their affection — an empty pool falls back to flavor rather than forcing something that isn't unlocked yet.

**Extended events** are multi-day arcs (2–7 days). One runs at a time, each fires at most once per playthrough, and an idle day has a 25% chance of starting one. An arc is only eligible if it can still finish before day 30, so a 7-day arc can't begin on day 26. There's deliberately **no** force-out guaranteeing every arc runs: the 13 arcs total 49 days of content against a 30-day game, so which arcs a playthrough sees is meant to vary.

**While an arc is active**, its own `sub_events` take 2/3 of firing segments — unrelated events still break through, an arc just dominates its week. Each sub-event declares an `eligible_segments` list and a `day_offset` window inside the arc, and lands one of three ways:
- **rolled** — the normal 2/3 weighting
- **forced** — if it reaches the last day of its window without having fired, it fires anyway, so no sub-event is ever missed
- **guaranteed** — beats flagged `final_day` (presentation day, post-show, …) always fire on the arc's last day, no roll

Sub-events flagged `ambient` span the whole arc and are written to survive repeating; they exist so an active arc actually fills its days instead of leaving most segments to unrelated events. The unflagged ones are the narrative one-offs.

**Which meter an event moves** is the optional `affects` field — absent means Hiyori, and only the four Yuki-route events set it. Shiori-focused events deliberately score against Hiyori's meter: she has no meter of her own and isn't a route, but she's protective of Hiyori, so how Adrian treats her reaches Hiyori indirectly.

**Who witnessed an event** is a separate question, and a separate optional field: `participant`. It decides whose knowledge base the event updates at end of day, and defaults to whatever `affects` says — correct for every Hiyori and Yuki event. Shiori's events are the exception and set it explicitly: they move Hiyori's meter, but *Shiori* is the one who saw what Adrian did. Attributing them to Hiyori would have her "remember" a conversation she wasn't part of, breaking the siloed-knowledge rule below.

### Endings
| Ending | Trigger |
|---|---|
| ✅ Good End | Confess with affection ≥ 80 |
| 😔 Friend Zone | Confess with affection 40–79 |
| 😨 Bad End | Confess with affection < 40 — she isn't there yet, and turns him down |
| ⏰ Too Late | Day 30 passes with no confession — Hiyori suddenly gets an overseas exchange + internship opportunity and the timing closes on its own |
| 🌸 Secret End | Yuki's hidden affection ≥ 70, and the player never confessed to Hiyori |

Confession is **never gated** by affection — the player can shoot their shot at any point, for better or worse.

### Why the ending happened

The ending itself is scripted prose, one of five. What follows it isn't.

Thirty days of play generate a diary and a per-character knowledge base, and until now every word of it existed only to feed retrieval — the player never saw any of it. `lib/ending-reflection.ts` reads that record back:

- **Her closing entry**, written the night it resolved, from her past entries and everything she came to notice about Adrian. The affection meter is hidden all game and the player is asked to read her behaviour instead; this is the one place she says it plainly.
- **The archive** — every earlier entry, oldest first, collapsed behind a toggle. The evidence behind the closing entry.
- **Yuki's epilogue**, only above `YUKI_REVEAL_FLOOR` (25) and never on the secret end, where she already said it out loud. Below that floor she genuinely didn't think about him much, and an epilogue would be inventing feelings the playthrough never earned.

Two prose calls on the fast model, measured at **2.8s** together — the ending screen paints the scripted prose immediately and this fills in behind it.

One content bug worth recording: `ENDING_FRAMING` originally used bare pronouns, and inside a Yuki-focused prompt *"she turned him down"* read as Yuki. The epilogue invented a rejection that never happened. Naming Hiyori explicitly in every framing string fixed it — a reminder that a prompt shared across two subjects has no pronoun context to fall back on.

---

## Tech Stack

| Layer | Tool |
|---|---|
| LLM | Gemma (via Google AI Studio, free tier, 32k context) |
| Embeddings | Google `gemini-embedding-001`, truncated to 768-dim (`text-embedding-004` was shut down by Google before this project reached ingestion) |
| Vector DB | Supabase pgvector |
| Database | Supabase (game state, messages, diary entries, events log) |
| Frontend | Next.js (App Router) + React + TypeScript + Tailwind 4 + Framer Motion |
| Backend | Next.js Route Handlers |
| Deployment | Vercel |

All chosen for generous free tiers — this project is designed to run at zero cost.

---

## RAG Architecture

```
Player action
  ↓
Embed query (gemini-embedding-001)
  ↓
pgvector similarity search, filtered by character + similarity threshold
  ↓
Retrieve top-k lore chunks
  ↓
Build prompt: [system + character personality + retrieved chunks + conversation history]
  ↓
Gemma generates response + affection delta (as JSON)
  ↓
Update Supabase game state
  ↓
End of day: re-embed + store new diary/knowledge chunks if triggered
```

### `lore_chunks` table design
Every chunk (static lore or dynamically generated) lives in one table, distinguished by:
- `is_static` — `true` for base lore ingested once, `false` for content generated during gameplay
- `session_id` — `null` for static lore (shared across all playthroughs), set for dynamic content (scoped to one playthrough)
- `character` — which NPC's knowledge this chunk belongs to (`hiyori`, `shiori`, `yuki`, or `events`)

This lets retrieval pull `is_static = true OR session_id = current_session` in one query — base lore plus whatever this specific playthrough has generated so far. Both `match_lore_chunks` and `match_lore_multi_character` take a `match_session_id` parameter implementing exactly this filter (added via the `add_session_scoping_to_lore_retrieval` migration).

> **Note on the `events` character bucket:** nothing in the game retrieves it yet — `lib/events.ts` resolves events by id from `events.json` directly, so there's no reason to find them by embedding search. It's kept current regardless, since it costs nothing and makes event lore available the moment something wants it.
>
> `scripts/ingest.ts` is **idempotent**: it clears before inserting, scoped to `is_static = true`. That scoping matters — dynamic chunks are a playthrough's generated memory (knowledge updates, diary entries), so deleting those would erase what the characters remember. Only base lore is disposable, because it rebuilds from `lore/` on demand. Without the clear step a re-run duplicated every chunk rather than refreshing it, which is precisely why the events content sat stale for days.

### Chunking strategy
Hybrid paragraph + section-heading split:
- Backstory/knowledge/interest files → split on `---` section headers
- Diary entries → one chunk per entry (already self-contained)
- `events.json` → one chunk per event object

Target size: 150–400 tokens per chunk.

---

## Lore Documents

- `hiyori_backstory.txt` — family, academic background, past relationships, habits
- `hiyori_interests.txt` — personality, likes/dislikes, hobbies, things she wants but won't say
- `hiyori_diary.txt` — static pre-game entries + dynamic entries generated during gameplay
- `diary_system.md` — spec for how/when diary entries are generated and what context Gemma receives
- `shiori_knowledge.txt` — what Shiori knows about Hiyori and Adrian, her advice style
- `yuki_knowledge.txt` — Yuki's background, her hidden feelings for Adrian, what she knows about Hiyori
- `adrian_profile.txt` — player character background (for NPCs to reference, not for a knowledge base of his own)
- `events.json` — all real-life events, extended/active events with sub-events, and the 5 endings

Adrian does **not** have a dynamic knowledge base — only Hiyori, Shiori, and Yuki maintain evolving perceptions of him.

---

## Frontend and the API boundary

The browser never imports `lib/` at runtime. `lib/supabase.ts` holds `SERVICE_ROLE`, which bypasses row-level security, and `lib/gemma.ts` holds `GOOGLE_API_KEY` — so all game logic runs inside route handlers and the client only ever talks to them over `fetch`. The page imports `lib/` *types* only, which are erased at compile time and never reach the client bundle.

| Route | Wraps | Notes |
|---|---|---|
| `POST /api/session` | `startNewGame` | Mints a `game_state` row; the returned id is the only save handle |
| `GET /api/session/:id` | `getGameState` | Resume after a refresh |
| `POST /api/day/start` | `startDay` | Schedule + which events fire in which segment |
| `POST /api/chat` | `sendPlayerMessage` | ~14s per reply |
| `POST /api/event/respond` | `recordEventResponse` | Persists free text; scoring waits for end of day |
| `POST /api/day/end` | `endDay` | 1m40s–4m24s. **Streams NDJSON progress** — see below |
| `POST /api/confess` | `confess` | Ends the run |

There are no accounts. Whoever holds the session id holds the save, which is why it's a UUID; the client keeps it in `localStorage`.

**End of day streams rather than returning once.** Measured runs range from **1m40s to 4m24s** — that spread is raw LLM latency, with no retries or model failures in between — and silence for that long is indistinguishable from a hang. So `endDay` emits a stage as each phase actually begins (`scoring`, `reflecting`, `diary`, `saving`) and the route forwards them as newline-delimited JSON. The progress shown is real, not a timed guess. Measuring also located the cost: **diary generation alone is ~60s**, and everything else is comparatively quick.

> **Known risk before deploying:** Vercel's Hobby plan allows **300s as both the default and the maximum** function duration (Pro reaches 800s). The slowest observed end-of-day used 264s of that — 88% — so a slower run returns a 504 and strands the player mid-day-end. The durable fix is splitting this into two requests (score events, then batch-eval) so neither approaches the cap. Until then the UI states the wait can reach about five minutes.

**Model choice is split by whether anyone is waiting.** Player-facing dialogue leads with `gemini-3.1-flash-lite`; end-of-day batch work leads with Gemma, which has the higher rate limit and is what the prompts were tuned against. Each is a fallback chain, so a rate limit falls through to the other model instead of failing the call — and leading them with different models splits load across two quota pools, so batch work can't starve the player's chat.

---

## Project Status

**Done:**
- Core game design (daily flow, schedule/time system, event system, ending conditions)
- Full lore documents for all 4 characters
- `events.json` finalized with capped extended-event durations and sub-events
- Supabase schema live (`lore_chunks`, `game_state`, `messages`, `diary_entries`, `events_log`) — note the live `lore_chunks` table and RPCs diverged from the originally drafted `supabase/schema.sql` (see `lib/supabase.ts` for the current, accurate contract)
- Full RAG ingestion pipeline built and verified end-to-end: `lib/chunking.ts` → `lib/embeddings.ts` → `lib/supabase.ts` → `scripts/ingest.ts` → `scripts/test-retrieval.ts`
- 61 static lore chunks embedded and ingested into `lore_chunks`; retrieval manually verified against real queries
- Gemma integration for NPC dialogue (`lib/gemma.ts`'s `generateDialogue`), grounded in retrieved lore + relationship stage
- Relationship tier/stage + diary-trigger logic (`lib/relationship.ts`)
- End-of-day batch evaluation (`lib/batch-eval.ts`'s `runEndOfDayBatchEval`) — updates per-NPC knowledge chunks, affection score, relationship stage, and diary entries (with RAG re-indexing). Verified end-to-end against the live DB + Gemini API (`scripts/tmp-test-batch-eval.ts`); independent Gemini calls run concurrently with a retry-once-after-60s wrapper for rate-limit resilience
- Retrieval scoping fix — `match_lore_chunks`/`match_lore_multi_character` now filter by `is_static`/`session_id` (see `lore_chunks` table design above), verified against real dynamic + static data (`scripts/tmp-test-retrieval-scoping.ts`)
- Single-turn chat handling (`lib/chat.ts`'s `sendPlayerMessage`) — retrieval + `generateDialogue` + persistence to `messages`, verified end-to-end (`scripts/tmp-test-chat.ts`), including that history stays correctly scoped to one character and one conversation continues coherently across turns
- Daily schedule generation (`lib/schedule.ts`'s `generateDailySchedule`), per the Schedule Generation section above, verified via `scripts/tmp-test-schedule.ts`
- Random event system (`lib/events.ts`), per the Event System section above — normal-day segment resolution, extended-event triggering, and in-arc sub-event resolution. Verified by simulation (`scripts/tmp-test-events.ts`, `scripts/tmp-test-arc.ts`): across 500 simulated runs of all 13 arcs, every sub-event lands and no final-day beat ever fires off the final day
- Event content expanded to 13 extended arcs (up from 3) spanning the affection range, plus per-arc ambient sub-events so an active arc actually fills its days

- Ending resolution (`lib/endings.ts`) and free-text event scoring (`generateEventOutcome`), with skipping an event scored deterministically instead — an unanswered event never reaches the LLM, which grades silence as a poor response and would conflate not engaging with fumbling
- Game loop orchestrator (`lib/orchestrator.ts`) — the full daily flow, with all extended-event state reconstructed from `events_log` rather than stored. Verified end-to-end against the live DB and API, including that an arc's start row isn't mistaken for an unanswered beat, and that `affects` routes deltas to the right meter (`scripts/tmp-test-orchestrator*.ts`, `scripts/tmp-test-yuki-routing.ts`)
- Events now feed each NPC's knowledge base, attributed by `participant` so a character only learns from what she was actually present for
- Confession (`confess()`), resolving immediately at any point in the run

- Next.js app and the full API surface, plus session creation (`startNewGame` — nothing minted a `game_state` row before, so there was no way to begin a playthrough). Verified over HTTP and in a browser: a complete day from new game through chat, event responses, and end of day
- The playable interface — in-game clock, the schedule as a proportional rail with the current segment marked, chat panel, event prompts, day-end recap and ending screens. `useDayClock` implements the real-time design: only `free` segments consume real time, sleep is skipped past, and activity segments are untimed because a countdown on a narrative beat pushes the player to answer badly rather than think
- Restyled to match the personal site's design system (see below), so it reads as native when embedded in that site's playground section
- `randomized_details` is finally applied — it was in the data and typed on `GameEvent` but nothing ever used it, so events reached the player with raw `[activity]` placeholders
- Ported into the personal site's playground section, behind a proxy route so `SERVICE_ROLE` and `GOOGLE_API_KEY` never leave this project (see Deployment). Verified running against a live engine, including that end-of-day's streamed progress survives the proxy hop rather than being buffered

- A refresh mid-day no longer duplicates it. `startDay` discards unanswered beats before re-rolling, sparing answered ones and arc markers; previously a reload could cost up to nine affection in skip penalties for beats the player never saw
- End of day can be retried after a failure, rather than stranding the player on a progress panel that never resolves
- Confessing explains itself and asks first — it was a bare link, one click from permanently ending a thirty-day run
- Chat messages carry the in-game time they were sent
- Retrieval evaluation harness (`npm run eval-retrieval`) — 23 hand-labelled cases scored on hit rate, MRR, clean negatives and similarity spread, with a saved baseline and per-run deltas. Labels are validated against the live corpus before scoring, since a label matching nothing scores identically to a retrieval failure
- `lore_chunks.source_file` stores the bare filename instead of an absolute path, so anything comparing against it works on any machine and on Vercel
- The ending explains itself (`lib/ending-reflection.ts`) — the accumulated diary and knowledge chunks are finally read back to the player instead of only feeding retrieval. See [Why the ending happened](#why-the-ending-happened). Verified against a seeded end-state (`scripts/tmp-test-ending-reflection.ts`) and, for the first time, in the browser: the closing entry, the collapsible archive, and the conditional Yuki epilogue all render

**Next up:**
- **Retrieval quality** — measured against a 23-case golden set and it doesn't hold up: 0% clean negatives, MRR 0.471, and every long/short query pair degrades. See [Known problems with retrieval](#known-problems-with-retrieval) for the baseline and the ranked list of 17 fixes
- **Temporal context in prompts** — characters have no idea what day or time it is, and it shows in what they say
- Split end-of-day into two requests, so neither approaches Vercel's 300s Hobby ceiling. This is the one item that can break a live game rather than merely look unfinished
- Play it. The 15-real-minutes-per-in-game-hour rate has never actually been sat through, only skipped past, so it's unvalidated
- **Day 2 onward** has never run for real — arc continuation across days is untested in the interface. (The ending screen was in this list; it has now been driven in a browser against a seeded end-state.)

All five endings are fully implemented — there is no missing mechanic behind any of them.
- Checkpoint/save system (password-based, session data purged after 1 week of inactivity)
- Responsive layout — built desktop-first and not yet checked on mobile

---

## Running locally

Needs `SUPABASE_URL`, `SERVICE_ROLE` and `GOOGLE_API_KEY` in `.env`.

```bash
npm run dev            # the game, standalone, on :3000
npm run ingest         # re-embed lore/ into lore_chunks (idempotent)
npm run eval-retrieval # score retrieval against eval/retrieval-golden.json
npm run typecheck
```

Playing writes real rows to Supabase — `game_state`, `messages`, `events_log`, and per-session `lore_chunks`. They're scoped by `session_id`, so clearing test playthroughs never touches the 71 static lore rows (`is_static = true`).

Two pacing notes that look like bugs but aren't: a chat reply takes **~14s**, and free segments run at **one in-game hour per fifteen real minutes** — use *skip ahead* unless you're specifically testing the clock.

To run it as it appears on the site instead, start this project on `:3000` and the personal site on `:3001` with `SOCIALSIM_API_URL=http://localhost:3000`.

---

## Known problems with retrieval

Retrieval was tuned against long, topical queries like *"what does she like to do on weekends"*. Real chat isn't like that — it's short and conversational — and measuring against actual messages shows the settings don't hold up.

Every message returns a full set of chunks, all scoring in a narrow band:

| query | chunks returned | score range |
|---|---|---|
| `morning` | 5 of 5 | 0.532 – 0.558 |
| `you okay?` | 5 of 5 | 0.533 – 0.581 |
| `do you want to grab lunch` | 5 of 5 | 0.514 – 0.574 |

A spread of ~0.04 between the best and worst hit means the ranking is close to arbitrary. `"morning"` retrieves diary entries about sleeplessness, succulents and cycling; `"you okay?"` retrieves a lab orientation. All of it is handed to the model under the heading **"RELEVANT MEMORY (things Hiyori knows)"**, so the prompt is mostly noise presented as fact.

The 0.5 threshold isn't filtering — it admits 8–18 chunks per query. And the cliff is sharp: 0.55 admits 1–3, and 0.6 admits **nothing at all**. There's no threshold that keeps good matches and drops bad ones, because for short queries there aren't good matches to keep.

Longer queries behave completely differently — *"has she ever been in a relationship before"* scores **0.716** with a 0.112 spread and returns exactly the right chunk. So the embedding and the corpus are fine; the problem is that a three-word message carries too little signal to discriminate.

### Measuring it: the golden set

Everything above was measured by hand, once. `npm run eval-retrieval` now scores retrieval against 23 hand-labelled cases in `eval/retrieval-golden.json`, so the next dozen changes can be compared instead of eyeballed.

A case is a query plus the chunk that *should* win, identified by `{ file, contains }` — not by id or `chunk_index`, since `npm run ingest` reinserts every static row and re-chunking shifts indices. Labels are validated against the live corpus before any case runs; a label matching zero chunks is a broken test, and it would otherwise score identically to a retrieval failure.

Four metrics, each over its own population:

| metric | what it answers |
|---|---|
| `hitRate` | did the right chunk appear at all — positive cases only |
| `mrr` | *where* did it land — rank 1 scores 1.0, rank 4 scores 0.25 |
| `cleanNegatives` | how often "no memory needed" correctly returned nothing |
| `meanSpread` | best minus worst similarity, over cases returning 2+ chunks |

`mrr` is the one that catches this codebase's actual failure: `hitRate` can read 88% while the right chunk sits at rank 4 behind three diary entries, and the model reads rank 1 hardest. `meanSpread` is the one that says whether it won *for a reason* — it needs no labels, so it measures confidence rather than correctness. It is **not comparable across thresholds**: raising the threshold truncates the low tail and shrinks spread mechanically.

Six of the 23 cases are **negatives that expect nothing at all**. Without them, "retrieve less" is invisible — every metric that rewards finding things punishes correctly finding nothing.

**Baseline, k=5, threshold=0.5** (`eval/baseline.json`; later runs print a delta against it):

| | |
|---|---|
| hit rate (positive) | 88% |
| MRR | 0.471 |
| clean negatives | **0%** |
| mean spread | 0.067 |
| mean chunks returned | 4.8 |

Two results stand out. **Clean negatives is 0%** — all six greetings and acknowledgements return a full set of chunks. And **mean chunks returned is 4.8 out of a possible 5**, confirming the 0.5 threshold filters essentially nothing.

The set deliberately pairs a long and a short query against the *same* target chunk, which isolates phrasing from everything else. All four pairs degrade:

| target chunk | long query | short query |
|---|---|---|
| `FOOD PREFERENCES` | rank 1, spread 0.160 | rank 3, spread 0.059 |
| `INTERESTS & HOBBIES` | rank 1, spread 0.082 | rank 4, spread 0.043 |
| `HIYORI FAMILY` | rank 1, spread 0.072 | rank 2, spread 0.047 |
| `WHAT ANNOYS OR PUTS HER OFF` | rank 1, spread 0.189 | **not retrieved**, spread 0.028 |

Same corpus, same answer, only the wording differs — and the spread roughly halves each time. That last row is the sharpest: *"sorry i'm late"* fails to retrieve the chunk that names lateness as a deal-breaker, so the model answers a genuinely character-defining moment with nothing.

One surprise: `"durian?"` — a single word — ranks its chunk **first**, because durian appears exactly once in the corpus. Rare tokens survive short queries; common ones drown. That is close to a direct argument for hybrid search.

### What to fix

Grouped by what each change actually attacks. Ordered so the cheap independent ones land before the two big ones.

**The corpus — what gets stored**
1. **Put the day inside knowledge chunk content.** It currently lives only in `source_file` as `dynamic-day-N`, which is neither embedded nor shown to the model, so a memory can't be placed in time and identical-format chunks have nothing to tell them apart.
2. **Enforce the diary's `[Day N — In-game]` tag** rather than asking the model for it in the prompt — there's no validation today.
3. **Persist in-game time.** `messages` has no time column; the timestamps in chat are derived client-side and lost on reload.
4. **Resolve the two dead pools.** `character='events'` (30 chunks) and `character='adrian'` (4) are retrieved by *nothing* — `matchLoreChunks` is only ever called with an `NPCCharacter`. That's 48% of the static corpus embedded and unreachable. The events chunks also embed `affection_outcomes`, so they're spoiler text and can't be wired in as-is.
5. **Re-chunk the long files.** Chunk sizes run 91–1521 chars, a 16× spread; long chunks average out to a mushy centroid and match everything weakly.
6. **Consolidate old knowledge chunks.** By day 30 each character has ~30 chunks from one prompt in one register — engineered to cluster tightly.

**The query — what gets asked**

7. **Embed more than the bare message** (last 2–3 turns). Still the single change most likely to fix it outright. `GoldenCase.context` exists for scoring this against the same set.
8. **Skip retrieval for greetings.** Six negative cases already measure this.
9. **HyDE / query rewriting.** Real gains on short queries, but it buys with an LLM call what hybrid search gives free.

**The ranking — what wins**

10. **Hybrid search: Postgres full-text + vector.** Short queries can't discriminate by cosine — that's inherent at that length, not a tuning failure. FTS gives `"morning"` a literal token. The `durian` result above is the evidence.
11. **Raise the threshold and accept empty results.** `buildPrompt` already writes *"(Nothing specific comes to mind.)"*, which beats five unrelated diary entries. At `--threshold 0.6` clean negatives goes 0% → 100% and MRR 0.471 → 0.800, at the cost of hit rate.
12. **Separate the pools, or weight by `source_file`.** Diary entries dominate; structured lore rarely surfaces even when it's the answer. `cycling-multi` measures exactly this.
13. **Recency in a re-rank pass.** Cosine has no reason to prefer day 25 over day 3. Depends on (1).
14. **Cap per source type** — max 2 diary + 2 knowledge + 2 static rather than top-5 overall.

**The prompt — how retrieved text is presented**

15. **Temporal context in `buildPrompt`** — see below.
16. **Stop labelling retrieved chunks as fact.** Five 0.53-similarity misses currently arrive under *"RELEVANT MEMORY (things Hiyori knows)"*.
17. **Move Adrian's profile out of retrieval and into the prompt.** Four chunks, always relevant to every NPC — retrieval is the wrong mechanism for something that is never *not* relevant.

Items 6 and 13 only pay off on a long run, and day 2+ has never been played in the UI, so they're research-shaped rather than fix-shaped for now.

### Missing temporal context

Separately: nothing in `buildPrompt` tells a character what day or time it is. It receives the persona, retrieved chunks, conversation history and relationship stage — no clock, no day number, no segment.

The effect is visible in play. At 06:14 in-game, Hiyori replied *"It's barely seven"* — she was guessing, and had no way not to. She also can't reference yesterday, notice that it's late, or tell day 2 from day 25. Now that messages carry in-game timestamps this mismatch is on screen next to every line.

The schedule and day number are already available where dialogue is generated, so this is a matter of adding them to the prompt rather than plumbing anything new.

---

## Known problem: end-of-day is slow, and the cause isn't what it looked like

End of day runs 210s on average and 242s at worst, against Vercel Hobby's hard 300s ceiling. `scripts/tmp-profile-endday.ts` breaks it down by phase (it timestamps the stage callbacks the route already streams, so no instrumentation is needed):

| phase | avg | share | |
|---|---|---|---|
| setup | 0.4s | 0% | fetch state and the day's rows |
| scoring | 22.8s | 11% | grade the day's answered beats |
| **reflecting** | **97.2s** | **46%** | knowledge updates + affection deltas |
| **diary** | **89.1s** | **42%** | generate and embed the diary |
| saving | 0.8s | 0% | writes, ending check, advance |

Three things this corrected:

- **The diary isn't the long pole.** `reflecting` is bigger. Splitting the diary off alone would still leave ~120s behind.
- **Concurrency isn't the problem.** `reflecting` fires five calls through `Promise.all`; running the same five sequentially takes **2.6× longer**. It's slow because Gemma is slow *and wildly variable* — identical work measured anywhere from 19s to 86s, and `Promise.all` finishes with its worst call.
- **"~14s per LLM call" was a dialogue figure.** A knowledge-update prompt takes 20–40s. Different prompt shape, different cost.

### The 23× option, and why it isn't free

On the same knowledge prompt, measured over several runs:

| model | avg | third person in 5 runs |
|---|---|---|
| `gemma-4-26b-a4b-it` | 24.0s | **0/5 violations** |
| `gemini-3.1-flash-lite` | **1.0s** | **5/5 violations** |

Flash-lite is 23× faster and would take end of day from 210s to roughly 15s — but it ignores the third-person instruction every single time, writing *"Adrian has a habit of catching **me** at **my** worst"* where the prompt requires *"Adrian did X — Hiyori took that to mean Y"*. Those chunks are stored and retrieved later, so first-person entries would poison the corpus the whole system reads back.

Two ways forward:

1. **Re-tune the batch prompts for flash-lite.** 23× faster, makes the 300s ceiling irrelevant and the game far nicer to play. Needs prompt work across all four batch call types and verification that each holds its format — the failure is at least loud and cheap to test for.
2. **Split end of day into separate requests.** Bounded and safe, no prompt risk, but a workaround for a 20× slower model: end of day still takes three and a half minutes. Natural seams are scoring / reflecting / diary, at roughly 23s, 97s and 89s — each request must leave the database in a state the next can resume from, which is what makes a mid-way failure recoverable rather than corrupting.

Worth trying (1) timeboxed first, and falling back to (2) if the format can't be held.

---

## Deployment

Two Vercel projects rather than one. This repo hosts the engine and its API; the personal site's playground page calls a thin proxy route there, which forwards to this deployment. `SERVICE_ROLE` and `GOOGLE_API_KEY` stay in this project only — a rate limit or a bad deploy here can't take the main site's build down with it, and this repo stays a standalone, showable record of the RAG work.

The proxy must **pipe the response body through untouched**. End of day streams NDJSON progress, and a proxy that does `await res.json()` would buffer the whole multi-minute response and destroy the progress reporting.

Everything runs on free tiers, with three caveats worth knowing:

- **Vercel Hobby caps function duration at 300s** — see the end-of-day risk above.
- **Supabase pauses free projects after 7 days of inactivity.** If nobody plays for a week the game breaks until the project is manually resumed; a scheduled ping avoids it.
- **Gemini's free tier has daily request caps.** A single day of play is roughly ten LLM calls, so a handful of players can exhaust the daily quota.

---

## Design Principles

- **Learning first, game second.** Architectural clarity is prioritized over gameplay complexity.
- **Siloed NPC knowledge.** No NPC-to-NPC gossip system — each character only knows what they experienced directly or were told by the player. Reduces complexity and keeps information flow entirely player-driven.
- **Narrative coherence matters.** Story details (like Hiyori's exchange program hint) are planted deliberately so late-game twists feel earned, not arbitrary.