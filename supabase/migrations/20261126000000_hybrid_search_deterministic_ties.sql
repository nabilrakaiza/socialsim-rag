-- ============================================================
-- Deterministic tie-breaking in match_lore_hybrid.
--
-- Why: with rrf_k = 3, ties in the fused score are common, not rare. A chunk
-- ranked (1st vector, 2nd lexical) scores exactly the same as one ranked
-- (2nd vector, 1st lexical): 1/4 + 1/5 either way. ts_rank also ties often on
-- a corpus this small, so row_number() in the lexical arm was arbitrary too.
--
-- Every ORDER BY here used to sort on the score alone, so Postgres broke ties
-- by physical row order. That order depends on the database's insert history,
-- not on the data. Measured: on a fresh database built from these migrations,
-- "what does she like to do in her free time" and "how's Ren doing" each had
-- two chunks tied at 0.25000 / 0.45000 for rank 1. The live project happened
-- to put the labelled chunk first and the fresh one didn't, so the same code
-- and the same lore gave MRR 0.859 on live and 0.815 on a fresh clone.
--
-- Fix: every ranking now ends in a key that is the same in every database:
--
--   1. the score being ranked on (unchanged)
--   2. cosine distance to the query (a semantic preference for ties)
--   3. source_file, chunk_index (identical wherever the same lore is ingested)
--   4. id (only reached by dynamic session rows, which repeat the same file
--      name; never reached by static lore)
--
-- id is a random uuid, so it can't be the main tie-break. It is new on every
-- ingest and differs between databases.
--
-- The function body is otherwise identical to 20260810030640_hybrid_search;
-- see that file for why each arm and the fusion are built the way they are.
-- ============================================================

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
  eligible as (
    select
      lore_chunks.id,
      lore_chunks.content,
      lore_chunks.source_file,
      lore_chunks.chunk_index,
      lore_chunks.content_tsv,
      lore_chunks.embedding <=> query_embedding as distance
    from public.lore_chunks
    where lore_chunks.character = match_character
      and (lore_chunks.is_static = true or lore_chunks.session_id = match_session_id)
  ),

  q as (
    select to_tsquery('english', nullif(replace(plainto_tsquery('english', query_text)::text, ' & ', ' | '), '')) as tsq
  ),

  vector_ranked as (
    select id, rank
    from (
      select
        eligible.id,
        row_number() over (
          order by eligible.distance, eligible.source_file, eligible.chunk_index, eligible.id
        ) as rank
      from eligible
    ) ranked
    where rank <= greatest(match_count * 4, 20)
  ),

  fts_ranked as (
    select id, rank
    from (
      select
        eligible.id,
        row_number() over (
          order by ts_rank(eligible.content_tsv, q.tsq) desc,
                   eligible.distance, eligible.source_file, eligible.chunk_index, eligible.id
        ) as rank
      from eligible
      cross join q
      where eligible.content_tsv @@ q.tsq
    ) ranked
    where rank <= greatest(match_count * 4, 20)
  ),

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

  select
    eligible.id,
    eligible.content,
    eligible.source_file,
    (1 - eligible.distance)::double precision as similarity,
    fused.score
  from fused
  join eligible on eligible.id = fused.id
  order by fused.score desc, eligible.distance, eligible.source_file, eligible.chunk_index, eligible.id
  limit match_count;
$$;
