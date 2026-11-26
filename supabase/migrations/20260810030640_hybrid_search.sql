-- ============================================================
-- Hybrid retrieval: full-text search fused with vector search.
--
-- Why: measured against eval/retrieval-golden.json, short conversational
-- queries can't be ranked by cosine similarity at all. Every chunk scores
-- ~0.55 and the spread between best and worst is ~0.03, so which chunk wins
-- is close to arbitrary. Two positives ("sorry i'm late", "you look tired")
-- aren't retrieved at all.
--
-- The scores of the two greetings that should return nothing (0.581, 0.592)
-- are HIGHER than every short query that has a real answer (0.547-0.574), so
-- no threshold can separate them. The fix has to change the scores, not
-- filter them.
--
-- Full-text search fails on different queries than vector search does — it
-- found both of the misses above, and returned exactly one chunk for
-- "durian?" where vector returned five indistinguishable ones. It is also
-- wrong where vector is right: for "grab lunch" it matches a diary entry that
-- mentions lunch rather than FOOD PREFERENCES, which never uses the word.
-- Neither is better. They are wrong about different things, which is the
-- whole reason to fuse rather than replace.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The text index
-- ------------------------------------------------------------
-- Generated, so ingestion doesn't change and existing rows are backfilled on
-- add. 'english' gives stemming (cycling -> cycl, tired -> tire) and stopword
-- removal, which is what lets a three-word message match at all.

alter table public.lore_chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists lore_chunks_content_tsv_idx
  on public.lore_chunks using gin (content_tsv);

-- ------------------------------------------------------------
-- 2. The hybrid RPC
-- ------------------------------------------------------------
-- Same filtering contract as match_lore_chunks: one character, and static
-- lore plus this session's dynamic memory only.
--
-- Note the return shape has BOTH similarity and score, and that is deliberate:
--
--   similarity  the true cosine value, kept so the eval harness's `spread`
--               metric stays comparable against the pre-hybrid baseline
--   score       the RRF fusion value used for ordering
--
-- Returning the RRF score in the `similarity` column instead would silently
-- break the baseline comparison — RRF values cluster around 1/61 ≈ 0.0164, so
-- every spread reading would collapse to ~0 and look like a catastrophic
-- regression when nothing had regressed.

create or replace function public.match_lore_hybrid(
  query_embedding vector,
  query_text text,
  match_character text,
  match_session_id text default null,
  match_count integer default 5,
  rrf_k integer default 3
)
returns table (
  id uuid,
  content text,
  source_file text,
  similarity double precision,
  score double precision
)
language sql
stable
as $$
  with
  -- Candidate pool, filtered once so both arms search the same rows.
  eligible as (
    select lore_chunks.id, lore_chunks.content, lore_chunks.source_file, lore_chunks.embedding, lore_chunks.content_tsv
    from public.lore_chunks
    where lore_chunks.character = match_character
      and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
  ),

  -- The text query. plainto_tsquery sanitizes arbitrary player input (strips
  -- punctuation, stems, drops stopwords) but joins terms with & — and almost
  -- no chunk contains every word of a conversational message, so the AND form
  -- returns nothing for most real queries. Swapping the operator gives OR
  -- semantics over already-sanitized terms.
  --
  -- The nullif guard matters: a message of pure punctuation produces an empty
  -- tsquery string, and to_tsquery('english', '') raises a syntax error rather
  -- than returning no rows.
  q as (
    select to_tsquery('english', nullif(replace(plainto_tsquery('english', query_text)::text, ' & ', ' | '), '')) as tsq
  ),

  -- Arm 1: dense/vector. Deliberately unthresholded — RRF consumes ranks, not
  -- scores, so a similarity cutoff here would just truncate the ranking that
  -- fusion is about to reweight.
  --
  -- Depth is capped by filtering on the computed rank, NOT by LIMIT. A bare
  -- LIMIT on a windowed select has no ORDER BY of its own, so it keeps an
  -- arbitrary subset of rows rather than the top-ranked ones — which silently
  -- dropped rank-1 chunks before fusion could see them.
  vector_ranked as (
    select id, similarity, rank
    from (
      select
        eligible.id,
        1 - (eligible.embedding <=> query_embedding) as similarity,
        row_number() over (order by eligible.embedding <=> query_embedding) as rank
      from eligible
    ) ranked
    where rank <= greatest(match_count * 4, 20)
  ),

  -- Arm 2: sparse/lexical.
  --
  -- An empty tsq (the guard above) is NULL, and `content_tsv @@ NULL` is NULL
  -- rather than true, so a punctuation-only message contributes no rows here —
  -- which is correct, not a case to work around.
  --
  -- This arm over-matches on common words by design: "you look tired, long
  -- day?" becomes 'look' | 'tire' | 'long' | 'day', and 'day' alone pulls a
  -- third of Hiyori's corpus. ts_rank still orders the right chunk 2nd, and
  -- the depth limit keeps the tail out of fusion — which is why the arm needs
  -- its own ordering rather than being treated as a flat filter.
  fts_ranked as (
    select id, rank
    from (
      select
        eligible.id,
        row_number() over (order by ts_rank(eligible.content_tsv, q.tsq) desc) as rank
      from eligible
      cross join q
      where eligible.content_tsv @@ q.tsq
    ) ranked
    where rank <= greatest(match_count * 4, 20)
  ),

  -- Fusion: Reciprocal Rank Fusion.
  --
  --   score = 1/(rrf_k + rank_vector) + 1/(rrf_k + rank_fts)
  --
  -- FULL OUTER JOIN, not inner: a chunk found by only one arm still competes,
  -- contributing that arm's term alone. An inner join would discard exactly
  -- the cases this change exists to fix — "sorry i'm late" is absent from the
  -- vector arm entirely.
  --
  -- The coalesce is on the TERM, not the rank. Coalescing a missing rank to 0
  -- would score 1/rrf_k, ranking a chunk one arm never found ABOVE a genuine
  -- first place.
  --
  -- Ranks rather than raw scores because the two are incomparable: cosine sits
  -- around 0.5-0.8 on this corpus, ts_rank around 0.06. Averaging lets cosine
  -- dominate outright, and normalising needs each distribution's range, which
  -- shifts per query.
  --
  -- rrf_k controls how much rank 1 dominates: low k trusts each arm's own
  -- ordering, high k rewards agreement across both. The literature default is
  -- 60; swept against the golden set, everything from 10 upward scored
  -- identically (MRR 0.554) and 3 was the peak (0.598).
  --
  -- Low k wins here because agreement is a weak signal on this corpus. The
  -- lexical arm ORs its terms, so a common word like "time" or "day" drags in
  -- a third of a 24-chunk pool; those chunks then score on both arms and
  -- outvote a chunk that is semantically perfect but shares no vocabulary with
  -- the query. At rrf_k=60 that sank hobbies-direct from rank 1 to unretrieved.
  --
  -- Caveat: 3 is tuned on 23 cases against one corpus. Re-sweep after any
  -- change to chunking or corpus size rather than treating it as settled.
  fused as (
    select
      coalesce(vector_ranked.id, fts_ranked.id) as id,
      (
        coalesce(1.0 / (rrf_k + vector_ranked.rank), 0)
        + coalesce(1.0 / (rrf_k + fts_ranked.rank), 0)
      )::double precision as score
    from vector_ranked
    full outer join fts_ranked on fts_ranked.id = vector_ranked.id
  )

  -- similarity is recomputed here rather than carried through fusion: a chunk
  -- the vector arm never ranked has no similarity to carry, and a NULL in that
  -- column would break the eval harness's spread and topSimilarity.
  select
    eligible.id,
    eligible.content,
    eligible.source_file,
    (1 - (eligible.embedding <=> query_embedding))::double precision as similarity,
    fused.score
  from fused
  join eligible on eligible.id = fused.id
  order by fused.score desc
  limit match_count;
$$;
