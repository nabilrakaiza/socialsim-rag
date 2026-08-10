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
| LLM | Google AI Studio free tier. Each call type has its own fallback chain across two quota pools — `gemini-3.1-flash-lite` then `gemma-4-26b-a4b-it` for dialogue, reversed for batch work (`lib/gemma.ts`) |
| Embeddings | Google `gemini-embedding-001`, truncated to 768-dim (`text-embedding-004` was shut down by Google before this project reached ingestion) |
| Retrieval | Supabase pgvector (dense) + Postgres full-text search (sparse), fused with RRF |
| Database | Supabase (game state, messages, diary entries, events log) |
| Frontend | Next.js 16 (App Router) + React 19 + TypeScript + Tailwind 4 + Motion |
| Backend | Next.js Route Handlers |
| Deployment | Vercel |

All chosen for generous free tiers — this project is designed to run at zero cost.

---

## RAG Architecture

```
Player message
  ↓
Does it need memory at all?  (lib/query-intent.ts)
  ├── no  ── greetings, acknowledgements: skip retrieval entirely, no API call
  ↓ yes
Embed query (gemini-embedding-001, 768-dim)
  ↓
match_lore_hybrid  ── two arms over the same candidate pool,
  ├── dense   pgvector cosine, ranked
  ├── sparse  Postgres full-text (GIN on content_tsv), ranked
  └── fused   Reciprocal Rank Fusion, k=3
  ↓            (both arms scoped by character + is_static/session_id)
Top-k chunks
  ↓
Build prompt:
  persona + Adrian profile block + WHEN THIS IS HAPPENING
  + retrieved chunks + conversation history + relationship stage
  ↓
Dialogue model generates the reply (JSON)
  ↓
End of day (batch, not per message):
  score events → knowledge chunks per character → affection deltas
  → diary entry if triggered → re-embed and store
```

Affection is deliberately **not** scored per message — it's a single end-of-day pass (`lib/batch-eval.ts`), so the meter reflects a day rather than a sentence.

### `lore_chunks` table design
Every chunk (static lore or dynamically generated) lives in one table, distinguished by:
- `is_static` — `true` for base lore ingested once, `false` for content generated during gameplay
- `session_id` — `null` for static lore (shared across all playthroughs), set for dynamic content (scoped to one playthrough)
- `character` — whose knowledge this chunk belongs to: `hiyori`, `shiori`, or `yuki`. Only these three, because retrieval is only ever called with an `NPCCharacter` — a chunk filed under anything else is unreachable by construction (see [Unreachable chunks](#unreachable-chunks))
- `content_tsv` — generated `tsvector` over `content`, with a GIN index, for the lexical arm of hybrid retrieval

This lets retrieval pull `is_static = true OR session_id = current_session` in one query — base lore plus whatever this specific playthrough has generated so far. `match_lore_chunks`, `match_lore_multi_character` and `match_lore_hybrid` all take a `match_session_id` parameter implementing exactly this filter.

> `scripts/ingest.ts` is **idempotent**: it clears before inserting, scoped to `is_static = true`. That scoping matters — dynamic chunks are a playthrough's generated memory (knowledge updates, diary entries), so deleting those would erase what the characters remember. Only base lore is disposable, because it rebuilds from `lore/` on demand. Without the clear step a re-run duplicated every chunk rather than refreshing it, which is precisely why the events content sat stale for days.

### Chunking strategy
Hybrid paragraph + section-heading split:
- Backstory/knowledge/interest files → split on `---` section headers
- Diary entries → one chunk per entry (already self-contained)
- `events.json` → not chunked. It's read directly by `lib/events.ts`, and what a character learns from an event she lived through reaches her as a dynamic knowledge chunk instead (see [Unreachable chunks](#unreachable-chunks))

Target size: 150–400 tokens per chunk.

---

## Lore Documents

- `hiyori_backstory.txt` — family, academic background, past relationships, habits
- `hiyori_interests.txt` — personality, likes/dislikes, hobbies, things she wants but won't say
- `hiyori_diary.txt` — static pre-game entries + dynamic entries generated during gameplay
- `diary_system.md` — spec for how/when diary entries are generated and what context the model receives. Reference only; not embedded
- `shiori_knowledge.txt` — what Shiori knows about Hiyori and Adrian, her advice style
- `yuki_knowledge.txt` — Yuki's background, her hidden feelings for Adrian, what she knows about Hiyori
- `adrian_profile.txt` — the player character, with per-NPC sections for what each of them knows about him. Not embedded: it's parsed into a fixed prompt block by `lib/adrian-profile.ts` (see [Unreachable chunks](#unreachable-chunks))
- `events.json` — all real-life events, extended/active events with sub-events, and the 5 endings. Not embedded: read directly by `lib/events.ts`

Adrian does **not** have a dynamic knowledge base — only Hiyori, Shiori, and Yuki maintain evolving perceptions of him.

---

## Frontend and the API boundary

The browser never imports `lib/` at runtime. `lib/supabase.ts` holds `SERVICE_ROLE`, which bypasses row-level security, and `lib/gemma.ts` holds `GOOGLE_API_KEY` — so all game logic runs inside route handlers and the client only ever talks to them over `fetch`. The page imports `lib/` *types* only, which are erased at compile time and never reach the client bundle.

| Route | Wraps | Notes |
|---|---|---|
| `POST /api/session` | `startNewGame` | Mints a `game_state` row; the returned id is the only save handle |
| `GET /api/session/:id` | `getGameState` | Resume after a refresh |
| `POST /api/day/start` | `startDay` | Schedule + which events fire in which segment |
| `POST /api/chat` | `sendPlayerMessage` | ~2s per reply (median; 1.3s when the greeting gate skips retrieval) |
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

- End of day can only run once per day, enforced in the database (`claim_day_for_scoring`). It's minutes of LLM work and isn't idempotent — a second run rescores the day, writes duplicate knowledge chunks, and applies affection twice with no record of each run's share, which makes the save unrepairable rather than untidy. Found the hard way: `useDayClock` called `onDayComplete` from inside a `setIndex` updater, React invokes updaters twice under Strict Mode to surface exactly that, and a real playthrough's day 1 was scored twice — leaving every character holding two contradictory memories of it. Fixed on the client too, but the client is the wrong place to enforce it
- A refresh mid-day no longer duplicates it. `startDay` discards unanswered beats before re-rolling, sparing answered ones and arc markers; previously a reload could cost up to nine affection in skip penalties for beats the player never saw
- End of day can be retried after a failure, rather than stranding the player on a progress panel that never resolves
- Confessing explains itself and asks first — it was a bare link, one click from permanently ending a thirty-day run
- Chat messages carry the in-game time they were sent
- Static corpus reduced 71 → 37 chunks, all of them reachable: the `events` and `adrian` pools were retrieved by nothing (see [Unreachable chunks](#unreachable-chunks)). Adrian is now a per-character prompt block in `lib/adrian-profile.ts`
- Characters know what time it is (`WHEN THIS IS HAPPENING` in `buildPrompt`) — day number, clock, time-of-day phrase, and current activity, sent from the client since the live clock is client-side state. See [Temporal context](#temporal-context)
- Knowledge chunks are only written when the day actually revealed something (`notable`), and the knowledge prompt receives correctly attributed turns — it was fed a transcript with Adrian's own lines labelled as the NPC's, and guessed wrong about a third of the time
- Knowledge chunks carry `[Day N]` in their content, so a memory can be placed in time and near-identical daily updates have something separating them
- Greeting gate (`lib/query-intent.ts`) — decides whether a message needs memory before anything is embedded, after measuring that neither cosine nor the fused score can separate greetings from real short questions. Clean negatives 0% → 100%, validated on 50 held-out messages (`npm run test-query-intent`)
- Hybrid retrieval (`match_lore_hybrid`) — Postgres full-text search fused with vector search via Reciprocal Rank Fusion, now the production path in `lib/chat.ts`. Rank-1 hits on the golden set went from 8 of 17 to 13 of 17. See [Hybrid retrieval](#hybrid-retrieval)
- Retrieval evaluation harness (`npm run eval-retrieval`) — 23 hand-labelled cases scored on hit rate, MRR, clean negatives and similarity spread, with a saved baseline and per-run deltas. Labels are validated against the live corpus before scoring, since a label matching nothing scores identically to a retrieval failure
- `lore_chunks.source_file` stores the bare filename instead of an absolute path, so anything comparing against it works on any machine and on Vercel
- The ending explains itself (`lib/ending-reflection.ts`) — the accumulated diary and knowledge chunks are finally read back to the player instead of only feeding retrieval. See [Why the ending happened](#why-the-ending-happened). Verified against a seeded end-state (`scripts/tmp-test-ending-reflection.ts`) and, for the first time, in the browser: the closing entry, the collapsible archive, and the conditional Yuki epilogue all render

**Next up:**
- **Retrieval quality** — hybrid search and the greeting gate landed: MRR 0.471 → 0.859, clean negatives 0% → 100%, chunks returned 4.8 → 3.7. Two cases still miss (`lunch-invite`, `apology-late`) and the remaining ranked fixes are in [Known problems with retrieval](#known-problems-with-retrieval)
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
npm run test-query-intent  # held-out check on the greeting gate
npm run eval-memory        # clustering of a playthrough's generated memory
npm run typecheck
```

Playing writes real rows to Supabase — `game_state`, `messages`, `events_log`, and per-session `lore_chunks`. They're scoped by `session_id`, so clearing test playthroughs never touches the 37 static lore rows (`is_static = true`).

A pacing note that looks like a bug but isn't: free segments run at **one in-game hour per fifteen real minutes** — use *skip ahead* unless you're specifically testing the clock.

Chat replies land in **~2s** (median over 5 messages; 1.3s for a greeting, which skips retrieval entirely). Earlier notes in this file said ~14s — that was the Gemma-first dialogue chain, before `gemini-3.1-flash-lite` took the first slot.

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

**Results.** Vector-only was the baseline; hybrid retrieval (below) is now what the game runs:

| | vector-only | + hybrid | + greeting gate |
|---|---|---|---|
| hit rate (positive) | 88% | 88% | 88% |
| MRR | 0.471 | 0.598 | **0.859** |
| positives at rank 1 | 8 of 17 | **13 of 17** | 13 of 17 |
| clean negatives | 0% | 0% | **100%** |
| mean spread | 0.067 | 0.096 | 0.106 |
| mean chunks returned | 4.8 | 5.0 | **3.7** |

Two results stood out on the vector-only run. **Clean negatives is 0%** — all six greetings and acknowledgements return a full set of chunks, and hybrid doesn't fix that (see below). And **mean chunks returned was 4.8 of a possible 5**, confirming the 0.5 threshold filters essentially nothing.

The set deliberately pairs a long and a short query against the *same* target chunk, which isolates phrasing from everything else. All four pairs degrade:

| target chunk | long query | short query |
|---|---|---|
| `FOOD PREFERENCES` | rank 1, spread 0.160 | rank 3, spread 0.059 |
| `INTERESTS & HOBBIES` | rank 1, spread 0.082 | rank 4, spread 0.043 |
| `HIYORI FAMILY` | rank 1, spread 0.072 | rank 2, spread 0.047 |
| `WHAT ANNOYS OR PUTS HER OFF` | rank 1, spread 0.189 | **not retrieved**, spread 0.028 |

Same corpus, same answer, only the wording differs — and the spread roughly halves each time. That last row is the sharpest: *"sorry i'm late"* fails to retrieve the chunk that names lateness as a deal-breaker, so the model answers a genuinely character-defining moment with nothing.

One surprise: `"durian?"` — a single word — ranks its chunk **first**, because durian appears exactly once in the corpus. Rare tokens survive short queries; common ones drown. That is close to a direct argument for hybrid search.

### Hybrid retrieval

`match_lore_hybrid` (see `supabase/migrations/0001_hybrid_search.sql`) runs full-text search alongside the vector search and fuses the two with Reciprocal Rank Fusion. `lib/chat.ts` calls it; `matchLoreChunks` is kept so both paths stay scoreable against the golden set.

**Why fusion rather than replacement.** The two methods are wrong about different queries. FTS found both cases vector missed entirely (`"sorry i'm late"`, `"you look tired"`) and returned exactly one candidate for `"durian?"` where vector returned five indistinguishable ones. But FTS is wrong where vector is right: for `"grab lunch"` it matches a diary entry mentioning lunch rather than `FOOD PREFERENCES`, which never uses the word. Neither arm is better — they fail differently, which is the entire premise.

**Ranks, not scores.** Cosine sits at 0.5–0.8 on this corpus and `ts_rank` around 0.06. Averaging lets cosine dominate outright, and normalising needs each distribution's range, which shifts per query. RRF discards both scores and keeps only the ordering: `score = 1/(k + rank_vector) + 1/(k + rank_fts)`.

**Three implementation traps**, all of which cost real debugging time:

1. `plainto_tsquery` joins terms with `&`, and almost no chunk contains *every* word of a conversational message — the AND form returned nothing for four of seven test queries. The fix swaps the operator to `|` on the already-sanitized output. A punctuation-only message then yields an empty tsquery string, and `to_tsquery('english', '')` *raises* rather than returning no rows, so it needs a `nullif` guard.
2. Cap candidate depth by filtering on the computed `rank`, never with a bare `LIMIT`. A `LIMIT` on a windowed select has no `ORDER BY` of its own, so it keeps an arbitrary subset — silently discarding rank-1 chunks before fusion sees them. This shipped in the first version and cost `hobbies-direct` and `cycling-invite` their correct rankings.
3. `FULL OUTER JOIN`, and coalesce the missing **term** to 0, not the missing **rank**. Rank 0 scores `1/k`, which outranks a genuine first place.

**Tuning.** `rrf_k` controls how much rank 1 dominates: low k trusts each arm's own ordering, high k rewards agreement. The literature default of 60 scored MRR 0.554; everything from 10 upward was identical; **3 peaked at 0.598** and is now the default. Low k wins here because agreement is a weak signal on a small corpus — the lexical arm ORs its terms, so a common word like `time` or `day` drags in a third of a 24-chunk pool, and those chunks then score on both arms and outvote one that is semantically perfect but shares no vocabulary with the query. At `rrf_k=60` that sank `hobbies-direct` from rank 1 to unretrieved. **3 is tuned on 23 cases against one corpus — re-sweep after any change to chunking or corpus size.**

**What it fixed and what it didn't.** Rank-1 hits went from 8 of 17 to 13 of 17, and `noticed-tired` went from unretrieved to rank 2. Hit rate is unchanged at 88%: `lunch-invite` regressed from rank 3 to unretrieved, trading places with `noticed-tired` — the predicted cost of FTS pointing at the wrong lunch chunk. `apology-late` still misses. **Clean negatives is still 0%**, and hybrid was never going to fix it: `"morning"` matches two chunks lexically, so the greetings still return a full set. That needs item 8.


### Knowing when not to retrieve

`lib/query-intent.ts` decides whether a message needs memory at all, before anything is embedded. `lib/chat.ts` and the eval harness both apply it.

**Why it isn't a score threshold.** Two cheaper approaches were measured and both failed. Cosine similarity: greetings scored 0.515–0.592 against 0.547–0.574 for short real questions, so the ranges overlap and two greetings outscored *every* real question. The fused RRF score after hybrid landed: the best possible cut keeps 16/17 positives but still admits 3/6 greetings. Neither population is separable by score, so the decision has to come from the message itself.

**The rule is subtractive**, not a pattern match: strip every word that carries no information need — English function words plus the closed classes of conversational speech (greetings, farewells, acknowledgements, politeness, laughter) — and see whether anything is left. *"sorry i'm late"* keeps `late` and retrieves, which is right: the chunk naming lateness as a deal-breaker is exactly what should ground that reply. *"sorry!"* alone keeps nothing and doesn't. Multi-word farewells get their own anchored phrase list, because *"see you tomorrow"* leaves `tomorrow`, a word that matters in *"what are you doing tomorrow"*.

Lexical rather than an LLM classifier: an extra round trip to recognise "morning" would roughly double a ~2s reply for no benefit. The check runs before embedding, so a greeting now costs **no API call at all**.

**Validating it honestly.** The rule was written while looking at the golden set's six negatives, so 6/6 there proves nothing — that's the fixture it was built against. `npm run test-query-intent` scores 50 held-out messages that appear nowhere in the golden set: **18/18 real questions correctly retrieve, 32/32 greetings correctly skip.**

That test treats the two error kinds asymmetrically, and only one fails the run. A greeting that slips through is wasteful but no worse than the old behaviour. A real question that gets blocked costs the character access to something she genuinely knows — so the run fails only on that direction.


### Unreachable chunks

`matchLoreChunks` and `match_lore_hybrid` are only ever called with an `NPCCharacter` — `'hiyori' | 'shiori' | 'yuki'`. Anything filed under another character is unreachable by construction, and two pools were:

| pool | chunks | fate |
|---|---|---|
| `character='events'` | 30 | removed from ingestion |
| `character='adrian'` | 4 | moved into the prompt |

That was **34 of 71 chunks — 48% of the static corpus — chunked, embedded, stored and searched by nothing.** The corpus is now 37 chunks, all reachable.

**The event chunks are gone rather than wired in.** Each embedded its own `affection_outcomes.high/mid/low`, so retrieving one would have handed a character the scoring rubric for an event that hadn't happened yet. They were also redundant: what a character learns from an event she was actually present for already reaches her through the dynamic knowledge chunk `lib/batch-eval.ts` writes at end of day, attributed by `participant`. `events.json` is still read directly by `lib/events.ts` — it just isn't embedded.

**Adrian's profile became a fixed prompt block** (`lib/adrian-profile.ts`). Retrieval is the wrong mechanism for it: similarity search exists to pick the relevant few from many, and Adrian is relevant to every single turn, so there is nothing to select. As a block it also stops competing with genuine memories for the five available slots.

It is **split per character**, not shared, because the file is: Shiori knows he's been asking about Hiyori more than casually, Yuki remembers his coffee order from secondary school. Merging those would break the siloed-knowledge rule the design rests on. The `BACKGROUND` section is deliberately excluded from all three — it reads *"He met Hiyori through Shiori. He didn't think much of it at first. That has changed."* That's Adrian's internal state, and putting it in Hiyori's prompt would tell her how he feels, which is the one thing the whole thirty-day game is built on her not knowing.

`lib/chunking.ts` now throws instead of defaulting when a lore file doesn't map to an NPC. A silent fallback is how 34 chunks ended up in pools nothing could search.


### Is per-playthrough memory searchable?

Everything above measures the **37 static chunks** — `eval/retrieval-golden.json` runs with `sessionId: null`. The memory a run generates had never been measured, and it can't be measured the same way: a golden case labels its answer with a substring that must exist before the test runs, and dynamic chunks don't exist until someone plays, in prose the model rewrites every time.

`npm run eval-memory` measures *properties* instead of answers. `scripts/seed-playthrough.ts` builds the corpus by running the real `endDay` for ten days of deliberately unrelated conversations — cycling, a lab report, a food stall, secondary school, rain, succulents. Seeding ten variations of one conversation would have guaranteed the clustering it was meant to detect.

**Two metrics failed before one worked, and both failures are instructive.**

*Exact-query hit@1* — query with a chunk's own stored embedding — scored 100% everywhere. It had to: cosine to itself is 1.0, its own text is its own best lexical match, so it takes rank 1 in both arms and scores `2/(rrf_k+1)`, unbeatable. Guaranteed by construction, not a quality signal.

*Excerpt hit@1* — query with roughly the middle half of a chunk's own words — was meant to fix that, and **also scored 100% everywhere**. The excerpt is verbatim text, so the lexical arm matches its source trivially. Adding full-text search made this class of test easier to pass, not harder.

Both survive as floor checks (they do catch scoping bugs and missing rows), but a test that genuinely discriminates needs **paraphrase** queries — same meaning, different words — which costs an LLM call per chunk or hand-written labels. That's a documented gap, not something to fake.

**The measurement that works is size-matched clustering.** Nearest-neighbour similarity rises with corpus size by chance alone, so an 11-chunk dynamic pool can't be compared against 24 static chunks directly. Subsampling static down to the dynamic pool's size, 400 times, gives a distribution to place it against:

| character | dynamic NN | static, same size | subsamples ≥ dynamic |
|---|---|---|---|
| hiyori | **0.884** | 0.796 (p05 0.776, p95 0.818) | **0 / 400** |
| shiori | 0.884 | 0.842 (p05 0.755, p95 0.887) | 48 / 400 |
| yuki | 0.859 | 0.858 (p05 0.826, p95 0.901) | 238 / 400 |

Hiyori's pool is the only one with enough chunks to be conclusive, and it is: **not one of 400 size-matched static samples is as tightly clustered as her generated memory.** Shiori and Yuki have 3 chunks each — far too few to say anything, and their rows are noise.

It's also getting worse as the run goes on: her nearest-neighbour mean was **0.799 at 5 chunks** and **0.884 at 11**. A thirty-day run has roughly triple that again.

**So the hypothesis holds**, though it took a wrong turn to confirm it.

Inspecting the actual chunks showed that **four of Hiyori's seven knowledge chunks were "nothing meaningful happened regarding Adrian today"** — paraphrases of one sentence, embedded and stored as retrievable memory. `buildKnowledgeChunk` only skipped generation when there were no messages *and* no events; a day where Adrian chatted but revealed nothing still wrote a chunk. That is most days, since a dating sim is mostly Adrian asking about her.

That's now fixed: the knowledge prompt returns a `notable` flag and nothing is written when it's false (`lib/gemma.ts`, `lib/batch-eval.ts`). A model-reported flag rather than pattern-matching the prose, which would break as soon as the wording drifted. Re-running the same ten seeded days: **4 null chunks of 7 → 0 of 6.**

The first attempt at that prompt **over-corrected to zero knowledge chunks across ten days** — the wording marked a day unremarkable "if he only asked questions", which is nearly every exchange in this game. Characters would have learned nothing, ever. The retuned version reserves false for genuinely empty exchanges and tells the model to err toward true.

**Removing the nulls did not improve clustering — it made it worse**, which is the opposite of what the fix was hoped to do and the more useful result:

| run | dynamic n | dynamic NN | static, same size | subsamples ≥ dynamic |
|---|---|---|---|---|
| with nulls | 11 | 0.884 | 0.796 | 0 / 400 |
| nulls removed | 8 | **0.905** | 0.785 | 0 / 400 |

The null chunks were semantically *distinct* from the substantive ones, so they were diluting the measurement. Strip them and what remains is the real finding: the substantive chunks converge hard on a single register — *"Adrian did X, she took that to mean Y"* — regardless of how different the days were. Consolidation is the fix for that, and it is now cleanly evidenced rather than inferred from a confounded number.

**A separate defect surfaced while reading the output, and turned out to be a one-word bug.** Two of six chunks attributed the wrong person's words to Adrian: day 1's exchange was Adrian asking *"where do you usually ride?"* and Hiyori answering, and the chunk read *"Adrian shared his usual cycling routes."*

The prompt wasn't at fault — its input was corrupted. `lib/batch-eval.ts` mapped every message with a hardcoded `role: "npc"`, discarding the real role from the database, so the knowledge prompt received a transcript where **Adrian's own lines were labelled as the NPC's**:

```
Hiyori: shiori said you cycle — where do you usually ride?     <- actually Adrian
Hiyori: east coast mostly, sometimes bukit timah...
```

It was then asked what she learned *about Adrian* and had to guess which half was his. `buildChatAffectionDelta` reads the same arrays, so affection was being scored off the same mislabelled transcript.

Fixed by passing `m.role` through. Both exchanges now read correctly — *"Adrian brought up her cycling based on something Shiori had mentioned — Hiyori noted that he's actually paying attention to the details people share."*

The honest limitation stands: clustering shows the chunks are hard to tell apart, not that a real query picks the wrong one. That needs paraphrase queries.


### What to fix

Grouped by what each change actually attacks. Ordered so the cheap independent ones land before the two big ones.

**The corpus — what gets stored**
1. ~~**Put the day inside knowledge chunk content.**~~ **Done** — knowledge chunks are now written as `[Day N] <update>`, so the day is both embedded and visible to the model. It was previously only in `source_file`, which is neither.
2. **Enforce the diary's `[Day N — In-game]` tag** rather than asking the model for it in the prompt — there's no validation today.
3. **Persist in-game time.** `messages` has no time column; the timestamps in chat are derived client-side and lost on reload.
4. ~~**Resolve the two dead pools.**~~ **Done** — see [Unreachable chunks](#unreachable-chunks).
5. **Re-chunk the long files.** Chunk sizes run 91–1521 chars, a 16× spread; long chunks average out to a mushy centroid and match everything weakly.
6. **Consolidate old knowledge chunks.** **Now evidence-backed** — see [Is per-playthrough memory searchable?](#is-per-playthrough-memory-searchable). Hiyori's generated memory is more tightly clustered than any of 400 size-matched samples of static lore, and removing the null chunks made it tighter still (0.905), not looser.

**The query — what gets asked**

7. **Embed more than the bare message** (last 2–3 turns). Still the single change most likely to fix it outright. `GoldenCase.context` exists for scoring this against the same set.
8. ~~**Skip retrieval for greetings.**~~ **Done** — see [Knowing when not to retrieve](#knowing-when-not-to-retrieve) below.
9. **HyDE / query rewriting.** Real gains on short queries, but it buys with an LLM call what hybrid search gives free.

**The ranking — what wins**

10. ~~**Hybrid search: Postgres full-text + vector.**~~ **Done** — see [Hybrid retrieval](#hybrid-retrieval) below.
11. **Raise the threshold and accept empty results.** `buildPrompt` already writes *"(Nothing specific comes to mind.)"*, which beats five unrelated diary entries. At `--threshold 0.6` clean negatives goes 0% → 100% and MRR 0.471 → 0.800, at the cost of hit rate.
12. **Separate the pools, or weight by `source_file`.** Diary entries dominate; structured lore rarely surfaces even when it's the answer. `cycling-multi` measures exactly this.
13. **Recency in a re-rank pass.** Cosine has no reason to prefer day 25 over day 3. Depends on (1).
14. **Cap per source type** — max 2 diary + 2 knowledge + 2 static rather than top-5 overall.

**The prompt — how retrieved text is presented**

15. ~~**Temporal context in `buildPrompt`**~~ **Done** — see [Temporal context](#temporal-context).
16. **Stop labelling retrieved chunks as fact.** Five 0.53-similarity misses currently arrive under *"RELEVANT MEMORY (things Hiyori knows)"*.
17. **Move Adrian's profile out of retrieval and into the prompt.** Four chunks, always relevant to every NPC — retrieval is the wrong mechanism for something that is never *not* relevant.

Item 13 only pays off on a long run, so it stays research-shaped for now. Item 6 no longer is — the clustering it addresses has been measured.

### Temporal context

`buildPrompt` used to receive the persona, retrieved chunks, conversation history and relationship stage — no clock, no day number, no segment. At 06:14 in-game Hiyori replied *"It's barely seven"*. She was guessing, and had no way not to.

It now gets a `WHEN THIS IS HAPPENING` block: the day number, the clock, a phrase for the time of day, and what she's in the middle of.

The **phrase** matters as much as the number. Nobody thinks *"it is 06:14"*, they think *"it is early"* — so the prompt carries both, and the phrase is what keeps the reply natural rather than making her recite a timestamp.

Plumbing note: the live clock is client-side state in `app/useDayClock.ts` and deliberately isn't persisted, so **nothing server-side can work out what time it is unless the client sends it**. `inGameHour` is now a required field on `/api/chat`, and the current segment maps to an activity phrase (`lunch`, `getting ready for the day`, …). Only free segments are chattable, so that map covers every case a message can be sent from.

Verified by sending the same message — *"hey, you around?"* — at three different times on the same day:

| in-game time | reply |
|---|---|
| 06:14 | *"It's barely past six, Adrian. Unless the world is ending… this is an incredibly strange hour to be checking if I'm around."* |
| 12:30, at lunch | *"I'm buried in a sandwich and a mountain of lab readings, so 'around' is a generous term for me right now."* |
| 23:45 | *"Do you have any idea what time it is, or are you just testing to see if I'm still awake enough to regret answering?"* |

The first row is the original bug, fixed and checkable: *"barely past six"* rather than *"barely seven"*.

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
- **"~14s per LLM call" was a dialogue figure**, and is now stale twice over: dialogue is ~2s on flash-lite. A knowledge-update prompt still takes 20–40s. Different prompt shape, different cost.

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