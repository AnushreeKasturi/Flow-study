-- Usage is recorded by the server, not by browsers.
-- Until now the server counted a request by calling api_allow() with the person's
-- own token, which meant anyone signed in could also call it directly and spend
-- their share of the budget without using anything. api_allow_for() can only be
-- called with the service-role key, which lives on the server alone.
--
-- Run only once the server has SUPABASE_SERVICE_ROLE_KEY set (in Vercel), since
-- the last line takes api_allow() away from browsers. Repeatable. Run after 015.

CREATE OR REPLACE FUNCTION public.api_allow_for(p_user UUID, p_kind TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  per_minute INT;
  per_hour INT;
  per_day INT;
  all_per_hour INT;
BEGIN
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user) THEN RAISE EXCEPTION 'Unknown account'; END IF;
  IF p_kind = 'ai' THEN per_minute := 10; per_hour := 30; per_day := 150; all_per_hour := 600;
  ELSIF p_kind = 'turn' THEN per_minute := 20; per_hour := 120; per_day := 300; all_per_hour := 3000;
  ELSE RAISE EXCEPTION 'Unknown quota';
  END IF;
  -- One request at a time per account and kind, so parallel calls cannot all pass the check before any is counted.
  PERFORM pg_advisory_xact_lock(hashtext('api_allow:' || p_user::text || ':' || p_kind));
  DELETE FROM public.api_usage WHERE at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.api_usage WHERE user_id = p_user AND kind = p_kind AND at > now() - interval '1 minute') >= per_minute
     OR (SELECT count(*) FROM public.api_usage WHERE user_id = p_user AND kind = p_kind AND at > now() - interval '1 hour') >= per_hour
     OR (SELECT count(*) FROM public.api_usage WHERE user_id = p_user AND kind = p_kind) >= per_day
     -- ponytail: the project-wide count is not locked, so a burst of different accounts can pass it by a few; it is a ceiling, not an exact meter.
     OR (SELECT count(*) FROM public.api_usage WHERE kind = p_kind AND at > now() - interval '1 hour') >= all_per_hour THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.api_usage (user_id, kind) VALUES (p_user, p_kind);
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.api_allow_for(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_allow_for(UUID, TEXT) TO service_role;

-- The browser-callable version now just hands over to it, for anything still using it...
CREATE OR REPLACE FUNCTION public.api_allow(p_kind TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN public.api_allow_for(auth.uid(), p_kind);
END $$;
-- ...but browsers can no longer call it.
REVOKE ALL ON FUNCTION public.api_allow(TEXT) FROM PUBLIC, anon, authenticated;
