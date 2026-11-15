-- Focus time per day, added up in the database. The profile used to download every saved
-- session and add them up in the browser, but the API returns at most 1,000 rows per
-- request, so long-time users' totals, streaks and charts silently fell short. One row per
-- day (in the person's own timezone) stays small. Safe to run twice.
CREATE OR REPLACE FUNCTION public.focus_days(p_tz TEXT DEFAULT 'UTC')
RETURNS TABLE(day DATE, seconds BIGINT, completed INT) LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  tz TEXT := COALESCE(NULLIF(left(p_tz, 64), ''), 'UTC');
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) THEN tz := 'UTC'; END IF;
  RETURN QUERY
    SELECT (s.completed_at AT TIME ZONE tz)::date, sum(s.duration_seconds)::bigint, (count(*) FILTER (WHERE s.mode = 'focus'))::int
    FROM public.sessions s
    WHERE s.user_id = auth.uid()
    GROUP BY 1
    ORDER BY 1;
END $$;
REVOKE ALL ON FUNCTION public.focus_days(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.focus_days(TEXT) TO authenticated;
