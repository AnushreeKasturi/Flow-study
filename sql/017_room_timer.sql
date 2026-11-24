-- The room's timer survives a reload, a sleeping laptop, or everyone leaving.
-- Until now the timer lived only in the browsers in the room: reload while
-- alone and the running block (and the lengths you chose) were gone. Every
-- timer change already passes through room_send(), so it now keeps the room's
-- latest full timer state, stamped with the server's clock. Rejoining restores
-- it and works out how much time has passed.
-- Repeatable until sql/018 is applied: after that, re-running this brings back the room_send()
-- that lets anyone change the timer, so run 018 again after it. Run after 016 in the Supabase SQL editor.

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS timer JSONB;
GRANT SELECT (timer) ON public.rooms TO authenticated;

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
  -- A full timer state (not the ten-second time-only ticks) is kept on the room,
  -- with only the timer's own fields, and when it was sent by the server's clock.
  IF p_event = 'timer-updated' AND p_payload ? 'isRunning' AND p_payload ? 'mode' THEN
    UPDATE public.rooms SET timer = (
      SELECT jsonb_object_agg(key, value) FROM jsonb_each(p_payload)
      WHERE key IN ('mode', 'timeLeft', 'isRunning', 'duration', 'sessionCount', 'durations', 'autoAdvance')
    ) || jsonb_build_object('at', now())
    WHERE id = p_room;
  END IF;
  PERFORM realtime.send(p_payload || jsonb_build_object('from', auth.uid()), p_event, 'room:' || p_room::text, true);
END $$;
REVOKE ALL ON FUNCTION public.room_send(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_send(UUID, TEXT, JSONB) TO authenticated;
