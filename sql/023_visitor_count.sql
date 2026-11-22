-- One public number for the README badge: how many browsers have ever visited Flow, the owner's left out.
-- The same count as /stats' "all time" visitors. Nothing else about visits leaves the database. Safe to run twice.
CREATE OR REPLACE FUNCTION public.visitor_count()
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(DISTINCT v.visitor) FROM public.visits v
  WHERE NOT EXISTS (SELECT 1 FROM public.excluded_visitors e WHERE e.visitor = v.visitor);
$$;
REVOKE ALL ON FUNCTION public.visitor_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.visitor_count() TO anon, authenticated;
