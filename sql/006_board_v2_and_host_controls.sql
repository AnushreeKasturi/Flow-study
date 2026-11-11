-- Board v2 (subjects, house rules, live status, planned groups, public read),
-- host controls (remove someone, close seats), reports, and seat limits that
-- also hold for people joining by code.
-- Additive and repeatable. Run after 005 in the Supabase SQL editor.

-- ── Listing details ─────────────────────────────────────────────────────────
ALTER TABLE public.open_rooms
    ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'other',
    ADD COLUMN IF NOT EXISTS camera TEXT NOT NULL DEFAULT 'optional',
    ADD COLUMN IF NOT EXISTS vibe TEXT NOT NULL DEFAULT 'quiet',
    ADD COLUMN IF NOT EXISTS timer_mode TEXT,
    ADD COLUMN IF NOT EXISTS timer_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE public.open_rooms ADD CONSTRAINT open_rooms_details CHECK (
    subject IN ('maths', 'science', 'programming', 'languages', 'writing', 'exams', 'other')
    AND camera IN ('on', 'optional', 'off') AND vibe IN ('quiet', 'chatty')
    AND (timer_mode IS NULL OR timer_mode IN ('focus', 'shortBreak', 'longBreak')));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The board is readable without signing in, so visitors can see that people
-- are studying. Still never room_id, and never the report count.
GRANT SELECT (id, host_id, host_name, topic, seats, seats_taken, last_seen, created_at, subject, camera, vibe, timer_mode, timer_ends_at, closed)
    ON public.open_rooms TO anon, authenticated;
GRANT INSERT (subject, camera, vibe, timer_mode, timer_ends_at, closed), UPDATE (subject, camera, vibe, timer_mode, timer_ends_at, closed)
    ON public.open_rooms TO authenticated;

-- (The read policy is defined after the reports section, which it depends on.)

-- ── Planned groups ──────────────────────────────────────────────────────────
-- "Organic chemistry, tonight at 8". People say they're in; at start time the
-- host opens a room, which then appears under open groups.
CREATE TABLE IF NOT EXISTS public.planned_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    host_name TEXT NOT NULL CHECK (char_length(host_name) BETWEEN 1 AND 40),
    topic TEXT NOT NULL CHECK (char_length(topic) BETWEEN 3 AND 80),
    subject TEXT NOT NULL DEFAULT 'other' CHECK (subject IN ('maths', 'science', 'programming', 'languages', 'writing', 'exams', 'other')),
    camera TEXT NOT NULL DEFAULT 'optional' CHECK (camera IN ('on', 'optional', 'off')),
    vibe TEXT NOT NULL DEFAULT 'quiet' CHECK (vibe IN ('quiet', 'chatty')),
    seats INT NOT NULL CHECK (seats BETWEEN 2 AND 6),
    starts_at TIMESTAMPTZ NOT NULL,
    going INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.planned_group_members (
    group_id UUID NOT NULL REFERENCES public.planned_groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.planned_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planned_group_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.planned_groups, public.planned_group_members FROM anon, authenticated;
GRANT SELECT (id, host_id, host_name, topic, subject, camera, vibe, seats, starts_at, going, created_at) ON public.planned_groups TO anon, authenticated;
GRANT INSERT (host_id, host_name, topic, subject, camera, vibe, seats, starts_at), DELETE ON public.planned_groups TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.planned_group_members TO authenticated;

DROP POLICY IF EXISTS planned_insert ON public.planned_groups;
CREATE POLICY planned_insert ON public.planned_groups FOR INSERT TO authenticated
    WITH CHECK (host_id = auth.uid() AND starts_at > now() - interval '5 minutes' AND starts_at < now() + interval '14 days');
DROP POLICY IF EXISTS planned_delete ON public.planned_groups;
CREATE POLICY planned_delete ON public.planned_groups FOR DELETE TO authenticated USING (host_id = auth.uid());

DROP POLICY IF EXISTS planned_members_select ON public.planned_group_members;
CREATE POLICY planned_members_select ON public.planned_group_members FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS planned_members_insert ON public.planned_group_members;
CREATE POLICY planned_members_insert ON public.planned_group_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS planned_members_delete ON public.planned_group_members;
CREATE POLICY planned_members_delete ON public.planned_group_members FOR DELETE TO authenticated USING (user_id = auth.uid());

-- A host may have three plans ahead of them at once, so one person can't fill the board.
CREATE OR REPLACE FUNCTION public.planned_groups_limit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM public.planned_groups WHERE host_id = NEW.host_id AND starts_at > now() - interval '2 hours') >= 3 THEN
    RAISE EXCEPTION 'Too many planned groups';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS planned_groups_limit ON public.planned_groups;
CREATE TRIGGER planned_groups_limit BEFORE INSERT ON public.planned_groups FOR EACH ROW EXECUTE FUNCTION public.planned_groups_limit();

-- "going" is the host plus everyone who said they're in. Kept by the database, never set by clients.
CREATE OR REPLACE FUNCTION public.planned_groups_count() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN v_group := OLD.group_id; ELSE v_group := NEW.group_id; END IF;
  UPDATE public.planned_groups g SET going = 1 + (SELECT count(*) FROM public.planned_group_members m WHERE m.group_id = v_group AND m.user_id <> g.host_id)
  WHERE g.id = v_group;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS planned_groups_count ON public.planned_group_members;
CREATE TRIGGER planned_groups_count AFTER INSERT OR DELETE ON public.planned_group_members FOR EACH ROW EXECUTE FUNCTION public.planned_groups_count();

-- ── Reports ─────────────────────────────────────────────────────────────────
-- Write-only for users; read them in the Supabase table editor.
-- A report is recorded against the host, not just the listing, so deleting a
-- listing and posting it again does not wipe the slate.
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('open', 'planned')),
    target UUID NOT NULL,
    host_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    topic TEXT CHECK (topic IS NULL OR char_length(topic) <= 80),
    reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reporter_id, kind, target)
);
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reports FROM anon, authenticated;
GRANT INSERT (kind, target, topic, reason) ON public.reports TO authenticated;
DROP POLICY IF EXISTS reports_insert ON public.reports;
CREATE POLICY reports_insert ON public.reports FOR INSERT TO authenticated WITH CHECK (reporter_id = auth.uid());

-- The database, not the reporter, decides who a report is about.
CREATE OR REPLACE FUNCTION public.reports_resolve() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.kind = 'open' THEN
    SELECT host_id INTO NEW.host_id FROM public.open_rooms WHERE id = NEW.target;
  ELSE
    SELECT host_id INTO NEW.host_id FROM public.planned_groups WHERE id = NEW.target;
  END IF;
  IF NEW.host_id IS NULL THEN RAISE EXCEPTION 'Listing not found'; END IF;
  IF NEW.host_id = NEW.reporter_id THEN RAISE EXCEPTION 'You cannot report your own listing'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reports_count ON public.reports;
DROP TRIGGER IF EXISTS reports_resolve ON public.reports;
CREATE TRIGGER reports_resolve BEFORE INSERT ON public.reports FOR EACH ROW EXECUTE FUNCTION public.reports_resolve();

-- Three different people reporting the same host within a week hides everything
-- that host has on the board, including anything they post afterwards.
CREATE OR REPLACE FUNCTION public.is_flagged(p_host UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(DISTINCT reporter_id) >= 3 FROM public.reports WHERE host_id = p_host AND created_at > now() - interval '7 days';
$$;
REVOKE ALL ON FUNCTION public.is_flagged(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_flagged(UUID) TO anon, authenticated;

DROP POLICY IF EXISTS open_rooms_select ON public.open_rooms;
CREATE POLICY open_rooms_select ON public.open_rooms FOR SELECT TO anon, authenticated
    USING ((last_seen > now() - interval '2 minutes' AND NOT public.is_flagged(host_id)) OR host_id = auth.uid());
DROP POLICY IF EXISTS planned_select ON public.planned_groups;
CREATE POLICY planned_select ON public.planned_groups FOR SELECT TO anon, authenticated
    USING ((starts_at > now() - interval '2 hours' AND NOT public.is_flagged(host_id)) OR host_id = auth.uid());

-- ── Host controls ───────────────────────────────────────────────────────────
-- The person who created a room is its host. Rooms made before this migration have no host.
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL;
GRANT SELECT (created_by) ON public.rooms TO authenticated;

CREATE TABLE IF NOT EXISTS public.room_bans (
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
ALTER TABLE public.room_bans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_bans FROM anon, authenticated;

-- One listing per room, posted by the room's creator. Otherwise any participant
-- could post a second listing and use it to close the room or dodge its seat limit.
-- (Rooms from before this migration have no creator; any one participant may list those.)
DELETE FROM public.open_rooms older USING public.open_rooms newer WHERE older.room_id = newer.room_id AND older.last_seen < newer.last_seen;
CREATE UNIQUE INDEX IF NOT EXISTS open_rooms_one_per_room ON public.open_rooms (room_id);

DROP POLICY IF EXISTS open_rooms_insert ON public.open_rooms;
CREATE POLICY open_rooms_insert ON public.open_rooms FOR INSERT TO authenticated WITH CHECK (
    host_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.room_participants p JOIN public.rooms r ON r.id = p.room_id
        WHERE p.room_id = open_rooms.room_id AND p.user_id = auth.uid() AND r.is_locked IS NOT TRUE
          AND (r.created_by IS NULL OR r.created_by = auth.uid())
    )
);
DROP POLICY IF EXISTS open_rooms_update ON public.open_rooms;
CREATE POLICY open_rooms_update ON public.open_rooms FOR UPDATE TO authenticated USING (host_id = auth.uid()) WITH CHECK (
    host_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.room_participants p JOIN public.rooms r ON r.id = p.room_id
        WHERE p.room_id = open_rooms.room_id AND p.user_id = auth.uid() AND r.is_locked IS NOT TRUE
          AND (r.created_by IS NULL OR r.created_by = auth.uid())
    )
);

-- Removes someone from a room for good: they lose access to its tasks and cannot rejoin.
CREATE OR REPLACE FUNCTION public.remove_participant(p_room UUID, p_user UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Only the host can remove someone';
  END IF;
  IF p_user = auth.uid() THEN
    RAISE EXCEPTION 'The host cannot remove themselves';
  END IF;
  DELETE FROM public.room_participants WHERE room_id = p_room AND user_id = p_user;
  INSERT INTO public.room_bans (room_id, user_id) VALUES (p_room, p_user) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.remove_participant(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_participant(UUID, UUID) TO authenticated;

-- Joining by code now also respects removals, and the seat limit of a room that is on the board.
CREATE OR REPLACE FUNCTION public.join_room(p_room_code TEXT, p_pin TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  room public.rooms%ROWTYPE;
  listing public.open_rooms%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    SELECT * INTO room FROM public.rooms WHERE room_code = upper(trim(p_room_code));
    IF NOT FOUND THEN RAISE EXCEPTION 'Room not found'; END IF;
    IF room.is_locked AND room.pin IS DISTINCT FROM p_pin THEN RAISE EXCEPTION 'Incorrect PIN'; END IF;
    IF EXISTS (SELECT 1 FROM public.room_bans WHERE room_id = room.id AND user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Removed from room';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = room.id AND user_id = auth.uid()) THEN
        SELECT * INTO listing FROM public.open_rooms WHERE room_id = room.id AND last_seen > now() - interval '2 minutes';
        IF FOUND AND (listing.closed OR listing.seats_taken >= listing.seats) THEN
            RAISE EXCEPTION 'Room is full';
        END IF;
    END IF;
    INSERT INTO public.room_participants (room_id, user_id) VALUES (room.id, auth.uid()) ON CONFLICT DO NOTHING;
    RETURN room.id;
END $$;
REVOKE ALL ON FUNCTION public.join_room(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_room(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.join_open_room(p_listing UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.open_rooms%ROWTYPE;
  v_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_listing FROM public.open_rooms
  WHERE id = p_listing AND last_seen > now() - interval '2 minutes' AND NOT public.is_flagged(host_id)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Group not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.room_bans WHERE room_id = v_listing.room_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Removed from room';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = v_listing.room_id AND user_id = auth.uid()) THEN
    IF v_listing.closed OR v_listing.seats_taken >= v_listing.seats THEN
      RAISE EXCEPTION 'Group is full';
    END IF;
    INSERT INTO public.room_participants (room_id, user_id) VALUES (v_listing.room_id, auth.uid())
    ON CONFLICT (room_id, user_id) DO NOTHING;
    UPDATE public.open_rooms SET seats_taken = seats_taken + 1 WHERE id = p_listing;
  END IF;

  SELECT room_code INTO v_code FROM public.rooms WHERE id = v_listing.room_id;
  RETURN v_code;
END $$;
REVOKE ALL ON FUNCTION public.join_open_room(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_open_room(UUID) TO authenticated;

-- ── Live board ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'open_rooms') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.open_rooms;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'planned_groups') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.planned_groups;
  END IF;
END $$;
