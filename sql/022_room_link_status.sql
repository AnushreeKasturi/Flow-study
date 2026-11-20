-- What a room link leads to, checked before joining, so a link to a room that just ended can say so.
-- Returns {"status": "open"}, {"status": "ended", "minutes": n} for 15 minutes after the room ends,
-- or {"status": "unknown"} for everything else: no such code, a room that ended longer ago, or a PIN room
-- the caller isn't in. An unknown answer counts as a wrong attempt, under join_room's per-account lock
-- and limit, so this tells no more than join_room would. Joining stays with join_room. Safe to run twice.
DROP FUNCTION IF EXISTS public.room_link_status(TEXT);
CREATE FUNCTION public.room_link_status(p_room_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  room public.rooms%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('join_room:' || auth.uid()::text));
  DELETE FROM public.join_failures WHERE at < now() - interval '10 minutes';
  IF (SELECT count(*) FROM public.join_failures WHERE user_id = auth.uid()) >= 10 THEN
    RAISE EXCEPTION 'Too many attempts';
  END IF;
  SELECT * INTO room FROM public.rooms WHERE room_code = upper(trim(p_room_code));
  IF FOUND AND NOT (room.is_locked AND NOT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = room.id AND user_id = auth.uid())) THEN
    IF room.ended_at IS NULL THEN RETURN jsonb_build_object('status', 'open'); END IF;
    IF room.ended_at > now() - interval '15 minutes' THEN
      RETURN jsonb_build_object('status', 'ended', 'minutes', floor(extract(epoch FROM now() - room.ended_at) / 60)::int);
    END IF;
  END IF;
  INSERT INTO public.join_failures (user_id) VALUES (auth.uid());
  RETURN jsonb_build_object('status', 'unknown');
END $$;
REVOKE ALL ON FUNCTION public.room_link_status(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_link_status(TEXT) TO authenticated;
