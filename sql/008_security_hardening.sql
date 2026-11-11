-- Security hardening. Additive and repeatable. Run after 007 in the Supabase SQL editor.
--   1. Rooms are visible only to their creator and members (was: every signed-in user could list every room code).
--   2. Room creation: valid codes and PINs only, creator recorded by the database, a daily cap.
--   3. Joining: repeated wrong codes or PINs are counted and throttled; failures no longer say which part was wrong.
--   4. Limits on stored focus sessions and on tasks per room.
--   5. A per-account quota for the assistant and TURN endpoints that holds across server instances.
--   6. room_send(): room messages go through the database, which stamps who sent them.

-- ── 1. Who can see a room ───────────────────────────────────────────────────
-- Policy names differ between installations, so replace whatever is there.
DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rooms' LOOP
    EXECUTE format('DROP POLICY %I ON public.rooms', p.policyname);
  END LOOP;
END $$;
CREATE POLICY rooms_select_member ON public.rooms FOR SELECT TO authenticated USING (
    created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.room_participants p WHERE p.room_id = rooms.id AND p.user_id = auth.uid())
);
CREATE POLICY rooms_insert_own ON public.rooms FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
REVOKE ALL ON public.rooms FROM anon;

-- ── 2. Creating a room ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rooms_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF; -- migrations and the SQL editor are not users
  NEW.created_by := auth.uid();                   -- never taken from the client
  IF NEW.room_code !~ '^[A-Z0-9]{6}$' THEN RAISE EXCEPTION 'Invalid room code'; END IF;
  IF NEW.pin IS NOT NULL AND NEW.pin !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'Invalid PIN'; END IF;
  NEW.is_locked := NEW.pin IS NOT NULL;
  IF (SELECT count(*) FROM public.rooms WHERE created_by = auth.uid() AND created_at > now() - interval '1 day') >= 40 THEN
    RAISE EXCEPTION 'Too many rooms created today';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rooms_guard ON public.rooms;
CREATE TRIGGER rooms_guard BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.rooms_guard();

-- ── 3. Joining ──────────────────────────────────────────────────────────────
-- A failed join has to be remembered, and a raised error would roll the note
-- back with it. So a wrong code or PIN now returns NULL instead of raising,
-- and does not say which of the two was wrong.
CREATE TABLE IF NOT EXISTS public.join_failures (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE, -- set when the code was right and the PIN wrong
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.join_failures ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES public.rooms(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS join_failures_recent ON public.join_failures (user_id, at);
CREATE INDEX IF NOT EXISTS join_failures_room ON public.join_failures (room_id, at);
ALTER TABLE public.join_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.join_failures FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.join_room(p_room_code TEXT, p_pin TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  room public.rooms%ROWTYPE;
  listing public.open_rooms%ROWTYPE;
  v_member BOOLEAN;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    -- One attempt at a time per account, so parallel guesses cannot slip past the count.
    PERFORM pg_advisory_xact_lock(hashtext('join_room:' || auth.uid()::text));
    -- Ten misses in ten minutes locks joining for the rest of that window.
    DELETE FROM public.join_failures WHERE at < now() - interval '10 minutes';
    IF (SELECT count(*) FROM public.join_failures WHERE user_id = auth.uid()) >= 10 THEN
        RAISE EXCEPTION 'Too many attempts';
    END IF;

    SELECT * INTO room FROM public.rooms WHERE room_code = upper(trim(p_room_code));
    IF NOT FOUND THEN
        INSERT INTO public.join_failures (user_id) VALUES (auth.uid());
        RETURN NULL;
    END IF;
    v_member := EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = room.id AND user_id = auth.uid());
    -- People already in the room are not asked for the PIN again, so the room-wide lock below never shuts them out.
    IF room.is_locked AND NOT v_member THEN
        -- A four-digit PIN falls to many accounts guessing a little each, so wrong PINs are
        -- also counted per room: twenty in ten minutes closes the room to newcomers for that window.
        PERFORM pg_advisory_xact_lock(hashtext('join_room_pin:' || room.id::text));
        IF (SELECT count(*) FROM public.join_failures WHERE room_id = room.id) >= 20 THEN
            RAISE EXCEPTION 'Too many attempts';
        END IF;
        IF room.pin IS DISTINCT FROM NULLIF(trim(p_pin), '') THEN
            INSERT INTO public.join_failures (user_id, room_id) VALUES (auth.uid(), room.id);
            RETURN NULL;
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public.room_bans WHERE room_id = room.id AND user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Removed from room';
    END IF;
    IF NOT v_member THEN
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

-- ── 4. Stored data limits ───────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE public.sessions ADD CONSTRAINT sessions_duration_range CHECK (duration_seconds BETWEEN 1 AND 14400) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.tasks_limit() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM public.tasks WHERE room_id::text = NEW.room_id::text) >= 500 THEN
    RAISE EXCEPTION 'This room has too many tasks';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tasks_limit ON public.tasks;
CREATE TRIGGER tasks_limit BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tasks_limit();

-- ── 5. Assistant and TURN quota ─────────────────────────────────────────────
-- The server calls this with the caller's own token. One call proves they are
-- signed in and counts the request, in one place for every server instance.
CREATE TABLE IF NOT EXISTS public.api_usage (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_usage_recent ON public.api_usage (user_id, kind, at);
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_allow(p_kind TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  per_minute INT;
  per_day INT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_kind = 'ai' THEN per_minute := 10; per_day := 150;
  ELSIF p_kind = 'turn' THEN per_minute := 20; per_day := 300;
  ELSE RAISE EXCEPTION 'Unknown quota';
  END IF;
  -- One request at a time per account and kind, so parallel calls cannot all pass the check before any is counted.
  PERFORM pg_advisory_xact_lock(hashtext('api_allow:' || auth.uid()::text || ':' || p_kind));
  DELETE FROM public.api_usage WHERE user_id = auth.uid() AND at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.api_usage WHERE user_id = auth.uid() AND kind = p_kind AND at > now() - interval '1 minute') >= per_minute
     OR (SELECT count(*) FROM public.api_usage WHERE user_id = auth.uid() AND kind = p_kind) >= per_day THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.api_usage (user_id, kind) VALUES (auth.uid(), p_kind);
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.api_allow(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_allow(TEXT) TO authenticated;

-- ── 6. Room messages, stamped by the database ───────────────────────────────
-- Chat, timer changes, call setup, and the rest go through here. Only members
-- can send, only known kinds of message, and "from" is always the real sender,
-- whatever the client put in the payload.
CREATE OR REPLACE FUNCTION public.room_send(p_room UUID, p_event TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not in this room';
  END IF;
  IF p_event NOT IN ('signal', 'timer-updated', 'chat-message', 'reaction', 'presence-heartbeat', 'youtube-sync', 'audio-sync', 'bye', 'removed') THEN
    RAISE EXCEPTION 'Unknown message';
  END IF;
  IF p_event = 'removed' AND NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Only the host can remove someone';
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text) > 24000 THEN
    RAISE EXCEPTION 'Invalid message';
  END IF;
  PERFORM realtime.send(p_payload || jsonb_build_object('from', auth.uid()), p_event, 'room:' || p_room::text, true);
END $$;
REVOKE ALL ON FUNCTION public.room_send(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_send(UUID, TEXT, JSONB) TO authenticated;
