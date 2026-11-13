-- Host handover, ending a room for everyone, and instant board updates.
-- Additive and repeatable. Run after 009 in the Supabase SQL editor.

-- ── Ending a room ───────────────────────────────────────────────────────────
-- An ended room keeps its tasks and everyone's focus history; it just can no
-- longer be joined, messaged, or listed.
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

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
        -- also counted per room: thirty in ten minutes closes the room to newcomers for that
        -- window. This can be used to keep newcomers out for a while, which is the lesser
        -- harm; people already in the room are never affected, and the room is told.
        PERFORM pg_advisory_xact_lock(hashtext('join_room_pin:' || room.id::text));
        IF (SELECT count(*) FROM public.join_failures WHERE room_id = room.id) >= 30 THEN
            RAISE EXCEPTION 'Too many attempts';
        END IF;
        IF room.pin IS DISTINCT FROM NULLIF(trim(p_pin), '') THEN
            INSERT INTO public.join_failures (user_id, room_id) VALUES (auth.uid(), room.id);
            IF (SELECT count(*) FROM public.join_failures WHERE room_id = room.id) = 30 THEN
                BEGIN
                    PERFORM realtime.send(jsonb_build_object('kind', 'pin-guessing'), 'notice', 'room:' || room.id::text, true);
                EXCEPTION WHEN OTHERS THEN NULL; -- telling the room is a courtesy; the lock holds regardless
                END;
            END IF;
            RETURN NULL;
        END IF;
    END IF;
    IF room.ended_at IS NOT NULL THEN
        RAISE EXCEPTION 'Room ended';
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


-- Sends a message from the database itself to a room or the board. A failure to
-- send is never allowed to undo the change that triggered it.
CREATE OR REPLACE FUNCTION public.flow_notify(p_topic TEXT, p_event TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM realtime.send(p_payload, p_event, p_topic, true);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
REVOKE ALL ON FUNCTION public.flow_notify(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.end_room(p_room UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND created_by = auth.uid() AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'Only the host can end the room';
  END IF;
  UPDATE public.rooms SET ended_at = now() WHERE id = p_room;
  DELETE FROM public.open_rooms WHERE room_id = p_room;
  PERFORM public.flow_notify('room:' || p_room::text, 'room-ended', '{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.end_room(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_room(UUID) TO authenticated;

-- ── Handing over the host role ──────────────────────────────────────────────
-- The room, and its board listing if it has one, pass to someone who is in it.
CREATE OR REPLACE FUNCTION public.transfer_host(p_room UUID, p_user UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND created_by = auth.uid() AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'Only the host can hand over the room';
  END IF;
  IF p_user = auth.uid() OR NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = p_user)
     OR EXISTS (SELECT 1 FROM public.room_bans WHERE room_id = p_room AND user_id = p_user) THEN
    RAISE EXCEPTION 'They are not in this room';
  END IF;
  SELECT COALESCE(NULLIF(trim(display_name), ''), 'Host') INTO v_name FROM public.profiles WHERE id = p_user;
  v_name := left(COALESCE(v_name, 'Host'), 40);
  UPDATE public.rooms SET created_by = p_user WHERE id = p_room;
  -- One listing per host. If they already list another room, that listing is
  -- theirs and is left alone; this room comes off the board instead.
  IF EXISTS (SELECT 1 FROM public.open_rooms WHERE host_id = p_user AND room_id <> p_room) THEN
    DELETE FROM public.open_rooms WHERE room_id = p_room;
  ELSE
    UPDATE public.open_rooms SET host_id = p_user, host_name = v_name WHERE room_id = p_room;
  END IF;
  PERFORM public.flow_notify('room:' || p_room::text, 'host-changed', jsonb_build_object('host', p_user, 'name', v_name));
  RETURN v_name;
END $$;
REVOKE ALL ON FUNCTION public.transfer_host(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_host(UUID, UUID) TO authenticated;

-- Seats in an ended room are never handed out.
CREATE OR REPLACE FUNCTION public.room_is_open(p_room UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND ended_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public.room_is_open(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_is_open(UUID) TO authenticated;

-- ── Seats in the board's rooms: not in an ended room ────────────────────────
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
  IF NOT public.room_is_open(v_listing.room_id) THEN
    RAISE EXCEPTION 'Group not found';
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

-- ── Room messages: not into an ended room ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.room_send(p_room UUID, p_event TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not in this room';
  END IF;
  IF NOT public.room_is_open(p_room) THEN
    RAISE EXCEPTION 'Room ended';
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

-- ── The board, live ─────────────────────────────────────────────────────────
-- A change to a listing or a plan pings the private "board" channel. The ping
-- carries nothing; pages fetch the board again, through the usual policies.
-- Only statements that really changed a row ping, and never more than twice a
-- second in total, so no one can flood everyone's board.
CREATE TABLE IF NOT EXISTS public.board_ping (id INT PRIMARY KEY CHECK (id = 1), at TIMESTAMPTZ NOT NULL);
INSERT INTO public.board_ping VALUES (1, 'epoch') ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.board_ping ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.board_ping FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.board_changed() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN RETURN NULL; END IF;
  UPDATE public.board_ping SET at = now() WHERE id = 1 AND at < now() - interval '500 milliseconds';
  IF FOUND THEN PERFORM public.flow_notify('board', 'changed', '{}'::jsonb); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS open_rooms_board_changed ON public.open_rooms;
DROP TRIGGER IF EXISTS planned_groups_board_changed ON public.planned_groups;
DO $$
DECLARE t TEXT; e TEXT;
BEGIN
  -- A trigger with a transition table can watch only one kind of change, so one per kind.
  FOREACH t IN ARRAY ARRAY['open_rooms', 'planned_groups'] LOOP
    FOREACH e IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_board_' || lower(e), t);
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I REFERENCING %s TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION public.board_changed()',
        t || '_board_' || lower(e), e, t, CASE WHEN e = 'DELETE' THEN 'OLD' ELSE 'NEW' END);
    END LOOP;
  END LOOP;
END $$;

-- Anyone may listen on the board channel (the board itself is public); nobody may send on it.
DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NOT NULL THEN
    DROP POLICY IF EXISTS flow_board_receive ON realtime.messages;
    CREATE POLICY flow_board_receive ON realtime.messages FOR SELECT TO anon, authenticated
      USING (realtime.messages.extension = 'broadcast' AND (SELECT realtime.topic()) = 'board');
    -- Room channels: members of rooms that are still open.
    DROP POLICY IF EXISTS flow_room_receive ON realtime.messages;
    CREATE POLICY flow_room_receive ON realtime.messages FOR SELECT TO authenticated USING (
      realtime.messages.extension IN ('broadcast', 'presence') AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic()) AND public.room_is_open(p.room_id)
      )
    );
    DROP POLICY IF EXISTS flow_room_send ON realtime.messages;
    CREATE POLICY flow_room_send ON realtime.messages FOR INSERT TO authenticated WITH CHECK (
      realtime.messages.extension = 'presence' AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic()) AND public.room_is_open(p.room_id)
      )
    );
  END IF;
END $$;
