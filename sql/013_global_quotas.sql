-- A ceiling on the whole project, not just each account.
-- The per-account quotas (sql/008) stop one person running up the AI and relay
-- bills, but many throwaway accounts could still do it together. These caps bound
-- the worst case for everyone. Raise them here as the site grows.
-- Anyone signed in can call this function directly, so no single account may use
-- more than a small share of the ceiling in an hour: using it all up would take
-- many accounts working together, not one script.
-- Repeatable. Run after 012 in the Supabase SQL editor.

CREATE INDEX IF NOT EXISTS api_usage_by_kind ON public.api_usage (kind, at);

CREATE OR REPLACE FUNCTION public.api_allow(p_kind TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  per_minute INT;
  per_hour INT;
  per_day INT;
  all_per_hour INT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_kind = 'ai' THEN per_minute := 10; per_hour := 30; per_day := 150; all_per_hour := 600;
  ELSIF p_kind = 'turn' THEN per_minute := 20; per_hour := 120; per_day := 300; all_per_hour := 3000;
  ELSE RAISE EXCEPTION 'Unknown quota';
  END IF;
  -- One request at a time per account and kind, so parallel calls cannot all pass the check before any is counted.
  PERFORM pg_advisory_xact_lock(hashtext('api_allow:' || auth.uid()::text || ':' || p_kind));
  DELETE FROM public.api_usage WHERE at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.api_usage WHERE user_id = auth.uid() AND kind = p_kind AND at > now() - interval '1 minute') >= per_minute
     OR (SELECT count(*) FROM public.api_usage WHERE user_id = auth.uid() AND kind = p_kind AND at > now() - interval '1 hour') >= per_hour
     OR (SELECT count(*) FROM public.api_usage WHERE user_id = auth.uid() AND kind = p_kind) >= per_day
     -- ponytail: the project-wide count is not locked, so a burst of different accounts can pass it by a few; it is a ceiling, not an exact meter.
     OR (SELECT count(*) FROM public.api_usage WHERE kind = p_kind AND at > now() - interval '1 hour') >= all_per_hour THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.api_usage (user_id, kind) VALUES (auth.uid(), p_kind);
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.api_allow(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_allow(TEXT) TO authenticated;
