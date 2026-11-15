-- Only whoever hosts the room right now may change its timer: the host, or while the host
-- has stepped away, the person standing in (sql/012). Enforced here, where every room message
-- passes (room_send), so a page can't get around it. Safe to run twice.

CREATE OR REPLACE FUNCTION public.runs_timer(p_room UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = p_room AND (
      (r.created_by = auth.uid() AND NOT r.host_away)
      OR (r.host_away AND r.acting_host = auth.uid() AND public.acting_live(r))
    )
  );
$$;
REVOKE ALL ON FUNCTION public.runs_timer(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.runs_timer(UUID) TO authenticated;

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
  IF p_event = 'timer-updated' AND NOT public.runs_timer(p_room) THEN
    RAISE EXCEPTION 'Only the host can change the timer';
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text) > 24000 THEN
    RAISE EXCEPTION 'Invalid message';
  END IF;
  -- A full timer state (not the time-only corrections) is kept on the room, with only the
  -- timer's own fields, its version, and when it was sent by the server's clock.
  IF p_event = 'timer-updated' AND p_payload ? 'isRunning' AND p_payload ? 'mode' THEN
    UPDATE public.rooms SET timer = (
      SELECT jsonb_object_agg(key, value) FROM jsonb_each(p_payload)
      WHERE key IN ('mode', 'timeLeft', 'isRunning', 'duration', 'sessionCount', 'durations', 'autoAdvance', 'version')
    ) || jsonb_build_object('at', now(), 'by', auth.uid())
    WHERE id = p_room;
  END IF;
  PERFORM realtime.send(p_payload || jsonb_build_object('from', auth.uid()), p_event, 'room:' || p_room::text, true);
END $$;
REVOKE ALL ON FUNCTION public.room_send(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_send(UUID, TEXT, JSONB) TO authenticated;
