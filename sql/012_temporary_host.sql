-- Stepping away, and hosting for now.
-- A host can step away instead of ending the room. The room stays open (and on
-- the board, for up to eight hours) with their seat kept. The first person in
-- hosts for now; only one person at a time, and the host role goes back to the
-- original host the moment they return.
-- Additive and repeatable. Run after 011 in the Supabase SQL editor.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS host_away BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS acting_host UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS acting_seen TIMESTAMPTZ;
-- Members already read their room's row (sql/008); these say who hosts it right now.
GRANT SELECT (host_away, acting_host) ON public.rooms TO authenticated;

-- The board shows who hosts a listing for now, and keeps an away host's listing up.
ALTER TABLE public.open_rooms
  ADD COLUMN IF NOT EXISTS away_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acting_name TEXT CHECK (acting_name IS NULL OR char_length(acting_name) <= 40);
GRANT SELECT (away_until, acting_name) ON public.open_rooms TO anon, authenticated;

-- A listing is live while its host checks in, or while its host has stepped away.
CREATE OR REPLACE FUNCTION public.listing_live(p_last_seen TIMESTAMPTZ, p_away_until TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_last_seen > now() - interval '2 minutes' OR p_away_until > now();
$$;
GRANT EXECUTE ON FUNCTION public.listing_live(TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated;

DROP POLICY IF EXISTS open_rooms_select ON public.open_rooms;
CREATE POLICY open_rooms_select ON public.open_rooms FOR SELECT TO anon, authenticated
    USING ((public.listing_live(last_seen, away_until) AND NOT public.is_flagged(host_id)) OR host_id = auth.uid());

-- Whoever is filling in for the host must check in every 45 seconds; after 90
-- seconds of silence (a closed laptop) the next person may take over.
CREATE OR REPLACE FUNCTION public.acting_live(p_room public.rooms) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_room.acting_host IS NOT NULL AND p_room.acting_seen > now() - interval '90 seconds' AND NOT public.is_flagged(p_room.acting_host);
$$;

CREATE OR REPLACE FUNCTION public.host_name_of(p_user UUID) RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT left(COALESCE((SELECT NULLIF(trim(display_name), '') FROM public.profiles WHERE id = p_user), 'Someone'), 40);
$$;
REVOKE ALL ON FUNCTION public.host_name_of(UUID) FROM PUBLIC, anon, authenticated;

-- ── The host steps away ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.step_away(p_room UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms WHERE id = p_room AND created_by = auth.uid() AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'Only the host can step away';
  END IF;
  UPDATE public.rooms SET host_away = true, acting_host = NULL, acting_seen = NULL WHERE id = p_room;
  -- Their seat stays counted, so it is free when they come back.
  UPDATE public.open_rooms SET away_until = now() + interval '8 hours', acting_name = NULL WHERE room_id = p_room;
  PERFORM public.flow_notify('room:' || p_room::text, 'host-changed', jsonb_build_object('host', '', 'name', ''));
END $$;
REVOKE ALL ON FUNCTION public.step_away(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.step_away(UUID) TO authenticated;

-- ── Someone hosts for now ───────────────────────────────────────────────────
-- Only while the host is away, and only if nobody else is already hosting.
-- The row lock makes two people asking at once take turns: the second sees the first.
CREATE OR REPLACE FUNCTION public.claim_host(p_room UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = auth.uid())
     OR EXISTS (SELECT 1 FROM public.room_bans WHERE room_id = p_room AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not in this room';
  END IF;
  -- Someone reported off the board is not put back on it as a host.
  IF public.is_flagged(auth.uid()) THEN RETURN false; END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room FOR UPDATE;
  IF v_room.ended_at IS NOT NULL OR NOT v_room.host_away OR v_room.created_by = auth.uid() THEN RETURN false; END IF;
  IF v_room.acting_host = auth.uid() THEN
    UPDATE public.rooms SET acting_seen = now() WHERE id = p_room;
    RETURN true;
  END IF;
  IF public.acting_live(v_room) THEN RETURN false; END IF;
  v_name := public.host_name_of(auth.uid());
  UPDATE public.rooms SET acting_host = auth.uid(), acting_seen = now() WHERE id = p_room;
  UPDATE public.open_rooms SET acting_name = v_name WHERE room_id = p_room;
  PERFORM public.flow_notify('room:' || p_room::text, 'host-changed', jsonb_build_object('host', auth.uid(), 'name', v_name));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_host(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_host(UUID) TO authenticated;

-- Whoever hosts for now keeps the listing's seat count and clock current.
CREATE OR REPLACE FUNCTION public.room_checkin(p_room UUID, p_seats_taken INT, p_timer_mode TEXT, p_timer_ends_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.rooms SET acting_seen = now()
  WHERE id = p_room AND host_away AND acting_host = auth.uid() AND ended_at IS NULL AND NOT public.is_flagged(auth.uid())
    AND EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = auth.uid());
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.open_rooms SET seats_taken = LEAST(GREATEST(p_seats_taken, 1), seats),
    timer_mode = CASE WHEN p_timer_mode IN ('focus', 'shortBreak', 'longBreak') THEN p_timer_mode END, timer_ends_at = p_timer_ends_at
  WHERE room_id = p_room;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.room_checkin(UUID, INT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_checkin(UUID, INT, TEXT, TIMESTAMPTZ) TO authenticated;

-- Whoever hosts for now is leaving: the next person may take over.
CREATE OR REPLACE FUNCTION public.release_host(p_room UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.rooms SET acting_host = NULL, acting_seen = NULL WHERE id = p_room AND acting_host = auth.uid();
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.open_rooms SET acting_name = NULL, seats_taken = GREATEST(seats_taken - 1, 1) WHERE room_id = p_room;
  PERFORM public.flow_notify('room:' || p_room::text, 'host-changed', jsonb_build_object('host', '', 'name', ''));
END $$;
REVOKE ALL ON FUNCTION public.release_host(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_host(UUID) TO authenticated;

-- ── The host comes back: joining hands the role straight back ───────────────
CREATE OR REPLACE FUNCTION public.join_room(p_room_code TEXT, p_pin TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  room public.rooms%ROWTYPE;
  listing public.open_rooms%ROWTYPE;
  v_member BOOLEAN;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('join_room:' || auth.uid()::text));
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
    IF room.is_locked AND NOT v_member THEN
        PERFORM pg_advisory_xact_lock(hashtext('join_room_pin:' || room.id::text));
        IF (SELECT count(*) FROM public.join_failures WHERE room_id = room.id) >= 30 THEN
            RAISE EXCEPTION 'Too many attempts';
        END IF;
        IF room.pin IS DISTINCT FROM NULLIF(trim(p_pin), '') THEN
            INSERT INTO public.join_failures (user_id, room_id) VALUES (auth.uid(), room.id);
            IF (SELECT count(*) FROM public.join_failures WHERE room_id = room.id) = 30 THEN
                PERFORM public.flow_notify('room:' || room.id::text, 'notice', jsonb_build_object('kind', 'pin-guessing'));
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
        SELECT * INTO listing FROM public.open_rooms WHERE room_id = room.id AND public.listing_live(last_seen, away_until);
        IF FOUND AND (listing.closed OR listing.seats_taken >= listing.seats) THEN
            RAISE EXCEPTION 'Room is full';
        END IF;
    END IF;
    INSERT INTO public.room_participants (room_id, user_id) VALUES (room.id, auth.uid()) ON CONFLICT DO NOTHING;
    -- The host is back: the role, and the listing, are theirs again.
    IF room.created_by = auth.uid() AND room.host_away THEN
        UPDATE public.rooms SET host_away = false, acting_host = NULL, acting_seen = NULL WHERE id = room.id;
        UPDATE public.open_rooms SET away_until = NULL, acting_name = NULL WHERE room_id = room.id;
        PERFORM public.flow_notify('room:' || room.id::text, 'host-changed', jsonb_build_object('host', auth.uid(), 'name', public.host_name_of(auth.uid())));
    END IF;
    RETURN room.id;
END $$;
REVOKE ALL ON FUNCTION public.join_room(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_room(TEXT, TEXT) TO authenticated;

-- Seats from the board: an away host's listing still hands them out.
CREATE OR REPLACE FUNCTION public.join_open_room(p_listing UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_listing public.open_rooms%ROWTYPE;
  v_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO v_listing FROM public.open_rooms
  WHERE id = p_listing AND public.listing_live(last_seen, away_until) AND NOT public.is_flagged(host_id)
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

-- Ending or handing over a room clears any stand-in.
CREATE OR REPLACE FUNCTION public.clear_acting_host() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    NEW.host_away := false; NEW.acting_host := NULL; NEW.acting_seen := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rooms_clear_acting_host ON public.rooms;
CREATE TRIGGER rooms_clear_acting_host BEFORE UPDATE OF ended_at, created_by ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.clear_acting_host();

-- Whether this room's board listing is yours, so a returning or new host picks
-- up the right one. (room_id itself stays unreadable.)
CREATE OR REPLACE FUNCTION public.lists_room(p_room UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.open_rooms WHERE room_id = p_room AND host_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.lists_room(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lists_room(UUID) TO authenticated;
