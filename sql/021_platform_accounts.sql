-- Every account, for the owner's /stats page: who signed up, whether they verified, and how much
-- they study. The owner's own accounts are left out. Run after 020. Safe to run twice.
CREATE OR REPLACE FUNCTION public.platform_accounts()
RETURNS TABLE(email TEXT, provider TEXT, joined TIMESTAMPTZ, verified BOOLEAN, last_sign_in TIMESTAMPTZ,
              focus_hours NUMERIC, study_days INT, last_studied TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  RETURN QUERY
    SELECT u.email::text, coalesce(u.raw_app_meta_data->>'provider', 'email'), u.created_at, u.email_confirmed_at IS NOT NULL, u.last_sign_in_at,
           round(coalesce(sum(s.duration_seconds), 0) / 3600.0, 1), count(DISTINCT s.completed_at::date)::int, max(s.completed_at)
    FROM auth.users u
    LEFT JOIN public.sessions s ON s.user_id = u.id AND s.mode LIKE 'focus%'
    WHERE NOT EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = u.id)
    GROUP BY u.id
    ORDER BY u.created_at DESC
    -- ponytail: newest 2,000 only; page through them if Flow ever outgrows that.
    LIMIT 2000;
END $$;
REVOKE ALL ON FUNCTION public.platform_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_accounts() TO authenticated;
