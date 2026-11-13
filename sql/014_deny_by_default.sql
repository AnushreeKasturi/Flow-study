-- Deny by default, whatever state a project started in.
-- schema.sql sets all of this up on a new project, but projects that began
-- before it, and upgraded through the numbered files, never had row-level
-- security on focus sessions, and signed-out visitors kept Supabase's default
-- grants on tables they have no use for. This closes both, and keeps future
-- tables closed until someone deliberately opens them.
-- Repeatable. Run after 013 in the Supabase SQL editor.

-- Focus sessions: your own, from rooms you joined.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_select_own" ON public.sessions;
CREATE POLICY "sessions_select_own" ON public.sessions FOR SELECT TO authenticated USING (
  auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.room_participants p WHERE p.room_id::text = sessions.room_id::text AND p.user_id = auth.uid())
);
DROP POLICY IF EXISTS "sessions_insert_own" ON public.sessions;
CREATE POLICY "sessions_insert_own" ON public.sessions FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.room_participants p WHERE p.room_id::text = sessions.room_id::text AND p.user_id = auth.uid())
);
REVOKE UPDATE, DELETE, TRUNCATE ON public.sessions FROM authenticated;

-- Every table has row-level security: one without policies is simply closed.
-- Signed-out visitors may read the public board, and nothing else.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF t NOT IN ('open_rooms', 'planned_groups') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    ELSE
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;

-- Tables created from now on start closed to signed-out visitors, rather than
-- picking up Supabase's default grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
