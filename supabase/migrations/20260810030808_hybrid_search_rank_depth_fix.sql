-- ============================================================
-- Placeholder, kept so this folder lines up with the live project's
-- migration history (20260810030808_hybrid_search_rank_depth_fix).
--
-- On live, this re-created match_lore_hybrid to rank each arm
-- greatest(match_count * 4, 20) deep. That change is already in
-- 20260810030640_hybrid_search.sql, which holds the final definition,
-- so there is nothing to apply here.
--
-- Note on rrf_k: the live version of this migration set the default
-- to 60. It was later lowered to 3 in the SQL editor after tuning
-- against eval/retrieval-golden.json. The previous file already uses 3,
-- and lib/supabase.ts passes rrf_k explicitly anyway.
-- ============================================================

select 1;
