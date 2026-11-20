-- Platform stats for the owner: who visits, who signs up and verifies, and how Flow is used.
-- Visits are Flow's own count: a random id the browser keeps (no cookies, no IP address),
-- one row per visitor, page and day. The owner's own devices and accounts are left out.
-- Make yourself the owner once, in the SQL editor:
--   INSERT INTO public.admins (user_id) SELECT id FROM auth.users WHERE email = 'you@example.com';
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS public.admins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admins FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.visits (
    day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
    visitor UUID NOT NULL,
    page TEXT NOT NULL CHECK (page ~ '^[a-z0-9-]{1,32}$'),
    source TEXT CHECK (source ~ '^[a-z0-9.-]{1,100}$'),
    device TEXT NOT NULL CHECK (device IN ('touch', 'desktop')),
    signed_in BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (day, visitor, page)
);
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visits FROM PUBLIC, anon, authenticated;

-- Browsers the owner has opened /stats in. Their visits are left out, past ones included.
CREATE TABLE IF NOT EXISTS public.excluded_visitors (
    visitor UUID PRIMARY KEY
);
ALTER TABLE public.excluded_visitors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.excluded_visitors FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Called by every page on flow-study.me, signed in or not.
CREATE OR REPLACE FUNCTION public.record_visit(p_visitor UUID, p_page TEXT, p_source TEXT, p_device TEXT, p_signed_in BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_visitor IS NULL OR EXISTS (SELECT 1 FROM public.excluded_visitors WHERE visitor = p_visitor) THEN RETURN; END IF;
  -- ponytail: anyone can call this with made-up ids, so a day's rows are capped; a script can still pad one day's count up to the cap.
  IF (SELECT count(*) FROM public.visits WHERE day = (now() AT TIME ZONE 'utc')::date) >= 50000 THEN RETURN; END IF;
  INSERT INTO public.visits (visitor, page, source, device, signed_in)
  VALUES (p_visitor, p_page, nullif(lower(left(p_source, 100)), ''), p_device, coalesce(p_signed_in, false))
  ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.record_visit(UUID, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_visit(UUID, TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated;

-- The /stats page calls this with its browser's visitor id, which stops counting that browser.
CREATE OR REPLACE FUNCTION public.exclude_visitor(p_visitor UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  INSERT INTO public.excluded_visitors VALUES (p_visitor) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.exclude_visitor(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exclude_visitor(UUID) TO authenticated;

-- Everything /stats shows, over the last p_days days (UTC), leaving out the owner.
CREATE OR REPLACE FUNCTION public.platform_stats(p_days INT DEFAULT 30)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  days INT := least(greatest(coalesce(p_days, 30), 1), 365);
  today DATE := (now() AT TIME ZONE 'utc')::date;
  since DATE := today - (days - 1);
  result JSONB;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  WITH
  people AS (SELECT * FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)),
  seen AS (SELECT * FROM public.visits v WHERE NOT EXISTS (SELECT 1 FROM public.excluded_visitors e WHERE e.visitor = v.visitor)),
  focus AS (SELECT s.* FROM public.sessions s JOIN people p ON p.id = s.user_id WHERE s.mode LIKE 'focus%'),
  series AS (SELECT generate_series(since, today, interval '1 day')::date AS day)
  SELECT jsonb_build_object(
    'days', days,
    'accounts', (SELECT jsonb_build_object(
        'total', count(*),
        'verified', count(*) FILTER (WHERE email_confirmed_at IS NOT NULL),
        'new', count(*) FILTER (WHERE created_at >= since),
        'new_verified', count(*) FILTER (WHERE created_at >= since AND email_confirmed_at IS NOT NULL),
        'signed_in', count(*) FILTER (WHERE last_sign_in_at >= since)) FROM people),
    'visitors', jsonb_build_object(
        'today', (SELECT count(DISTINCT visitor) FROM seen WHERE day = today),
        'week', (SELECT count(DISTINCT visitor) FROM seen WHERE day > today - 7),
        'period', (SELECT count(DISTINCT visitor) FROM seen WHERE day >= since),
        'all_time', (SELECT count(DISTINCT visitor) FROM seen),
        'page_views', (SELECT count(*) FROM seen WHERE day >= since),
        'returning', (SELECT count(*) FROM (SELECT visitor FROM seen WHERE day >= since GROUP BY visitor HAVING count(DISTINCT day) > 1) r)),
    'study', jsonb_build_object(
        'studiers', (SELECT count(DISTINCT user_id) FROM focus WHERE completed_at >= since),
        'studiers_all_time', (SELECT count(DISTINCT user_id) FROM focus),
        'regulars', (SELECT count(*) FROM (SELECT user_id FROM focus WHERE completed_at >= since GROUP BY user_id HAVING count(DISTINCT completed_at::date) >= 3) r),
        'focus_hours', (SELECT round(coalesce(sum(duration_seconds), 0) / 3600.0, 1) FROM focus WHERE completed_at >= since),
        'focus_hours_all_time', (SELECT round(coalesce(sum(duration_seconds), 0) / 3600.0, 1) FROM focus),
        'sessions', (SELECT count(*) FROM focus WHERE completed_at >= since AND mode = 'focus'),
        'average_minutes', (SELECT round(coalesce(avg(duration_seconds), 0) / 60.0, 1) FROM focus WHERE completed_at >= since),
        'rooms', (SELECT count(*) FROM public.rooms r WHERE r.created_at >= since AND (r.created_by IS NULL OR r.created_by IN (SELECT id FROM people))),
        'rooms_all_time', (SELECT count(*) FROM public.rooms r WHERE r.created_by IS NULL OR r.created_by IN (SELECT id FROM people)),
        'tasks', (SELECT count(*) FROM public.tasks t WHERE t.created_at >= since AND t.created_by IN (SELECT id FROM people)),
        'tasks_done', (SELECT count(*) FROM public.tasks t WHERE t.created_at >= since AND t.completed AND t.created_by IN (SELECT id FROM people)),
        'groups_open_now', (SELECT count(*) FROM public.open_rooms o WHERE o.last_seen > now() - interval '2 minutes' AND o.host_id IN (SELECT id FROM people)),
        'groups_planned', (SELECT count(*) FROM public.planned_groups g WHERE g.starts_at > now() AND g.host_id IN (SELECT id FROM people))),
    'daily', (SELECT jsonb_agg(jsonb_build_object(
        'day', d.day,
        'visitors', (SELECT count(DISTINCT visitor) FROM seen WHERE seen.day = d.day),
        'signups', (SELECT count(*) FROM people WHERE created_at::date = d.day),
        'studiers', (SELECT count(DISTINCT user_id) FROM focus WHERE completed_at::date = d.day),
        'focus_hours', (SELECT round(coalesce(sum(duration_seconds), 0) / 3600.0, 1) FROM focus WHERE completed_at::date = d.day)
      ) ORDER BY d.day) FROM series d),
    'pages', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', page, 'visitors', n) ORDER BY n DESC, page), '[]') FROM
        (SELECT page, count(DISTINCT visitor) n FROM seen WHERE day >= since GROUP BY page) x),
    'sources', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', source, 'visitors', n) ORDER BY n DESC, source), '[]') FROM
        (SELECT coalesce(source, 'direct') source, count(DISTINCT visitor) n FROM seen WHERE day >= since GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10) x),
    'devices', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', device, 'visitors', n) ORDER BY n DESC, device), '[]') FROM
        (SELECT device, count(DISTINCT visitor) n FROM seen WHERE day >= since GROUP BY device) x)
  ) INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.platform_stats(INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_stats(INT) TO authenticated;
