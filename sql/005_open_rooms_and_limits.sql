-- Study-groups board, plus size limits on stored text.
-- Additive and repeatable: safe to run on a live database, and safe to run twice.
-- Run after 004 in the Supabase SQL editor.

-- ── Size limits ─────────────────────────────────────────────────────────────
-- The app already limits these in the browser; the database now refuses
-- oversized values from any other client. NOT VALID leaves existing rows alone.
DO $$ BEGIN
  ALTER TABLE public.tasks ADD CONSTRAINT tasks_title_length CHECK (char_length(title) BETWEEN 1 AND 200) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_display_name_length CHECK (display_name IS NULL OR char_length(display_name) <= 60) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.rooms ADD CONSTRAINT rooms_code_length CHECK (char_length(room_code) <= 12) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Open rooms ──────────────────────────────────────────────────────────────
-- A host lists the room they are in so others can find it. One listing per
-- host. The host's browser refreshes last_seen while they are in the room, and
-- listings older than two minutes are invisible, so nothing needs cleaning up.
CREATE TABLE IF NOT EXISTS public.open_rooms (
    host_id UUID PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    host_name TEXT NOT NULL CHECK (char_length(host_name) BETWEEN 1 AND 40),
    topic TEXT NOT NULL CHECK (char_length(topic) BETWEEN 3 AND 80),
    seats INT NOT NULL CHECK (seats BETWEEN 2 AND 6),
    -- Reported by the host's browser: only live presence knows who is in the room right now.
    seats_taken INT NOT NULL DEFAULT 1 CHECK (seats_taken BETWEEN 1 AND 50),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.open_rooms ENABLE ROW LEVEL SECURITY;

-- room_id is deliberately not readable: the room's realtime channel is named
-- after it, so the board hands out seats through join_open_room() instead.
REVOKE ALL ON public.open_rooms FROM anon, authenticated;
GRANT SELECT (id, host_id, host_name, topic, seats, seats_taken, last_seen, created_at) ON public.open_rooms TO authenticated;
-- Writable columns only. last_seen is never taken from the client (see the trigger below).
GRANT INSERT (host_id, room_id, host_name, topic, seats, seats_taken), UPDATE (host_id, room_id, host_name, topic, seats, seats_taken), DELETE ON public.open_rooms TO authenticated;

-- A listing stays visible for two minutes after its host last touched it, by the
-- server's clock. Without this a host could post-date last_seen and never expire.
-- Someone taking a seat changes seats_taken but must not keep a hostless listing alive.
CREATE OR REPLACE FUNCTION public.open_rooms_stamp() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR auth.uid() = NEW.host_id THEN
    NEW.last_seen := now();
  ELSIF auth.uid() IS NOT NULL THEN
    NEW.last_seen := OLD.last_seen;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS open_rooms_stamp ON public.open_rooms;
CREATE TRIGGER open_rooms_stamp BEFORE INSERT OR UPDATE ON public.open_rooms FOR EACH ROW EXECUTE FUNCTION public.open_rooms_stamp();

DROP POLICY IF EXISTS open_rooms_select ON public.open_rooms;
CREATE POLICY open_rooms_select ON public.open_rooms FOR SELECT TO authenticated
    USING (last_seen > now() - interval '2 minutes' OR host_id = auth.uid());

-- Only someone who is in the room may list it, and never a PIN-locked room.
DROP POLICY IF EXISTS open_rooms_insert ON public.open_rooms;
CREATE POLICY open_rooms_insert ON public.open_rooms FOR INSERT TO authenticated WITH CHECK (
    host_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.room_participants p JOIN public.rooms r ON r.id = p.room_id
        WHERE p.room_id = open_rooms.room_id AND p.user_id = auth.uid() AND r.is_locked IS NOT TRUE
    )
);
DROP POLICY IF EXISTS open_rooms_update ON public.open_rooms;
CREATE POLICY open_rooms_update ON public.open_rooms FOR UPDATE TO authenticated USING (host_id = auth.uid()) WITH CHECK (
    host_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.room_participants p JOIN public.rooms r ON r.id = p.room_id
        WHERE p.room_id = open_rooms.room_id AND p.user_id = auth.uid() AND r.is_locked IS NOT TRUE
    )
);
DROP POLICY IF EXISTS open_rooms_delete ON public.open_rooms;
CREATE POLICY open_rooms_delete ON public.open_rooms FOR DELETE TO authenticated USING (host_id = auth.uid());

-- Takes a seat in a listed room and returns its code. The seat check and the
-- membership insert happen under one row lock, so two people cannot take the
-- last seat. The host's next refresh replaces seats_taken with the real count.
CREATE OR REPLACE FUNCTION public.join_open_room(p_listing UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_listing public.open_rooms%ROWTYPE;
  v_code TEXT;
  v_member BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT * INTO v_listing FROM public.open_rooms
  WHERE id = p_listing AND last_seen > now() - interval '2 minutes'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group not found';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = v_listing.room_id AND user_id = auth.uid()) INTO v_member;
  IF NOT v_member THEN
    IF v_listing.seats_taken >= v_listing.seats THEN
      RAISE EXCEPTION 'Group is full';
    END IF;
    INSERT INTO public.room_participants (room_id, user_id) VALUES (v_listing.room_id, auth.uid())
    ON CONFLICT (room_id, user_id) DO NOTHING;
    UPDATE public.open_rooms SET seats_taken = seats_taken + 1 WHERE id = p_listing;
  END IF;

  SELECT room_code INTO v_code FROM public.rooms WHERE id = v_listing.room_id;
  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.join_open_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_open_room(UUID) TO authenticated;
