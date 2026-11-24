-- Rooms and focus sessions keep to what the browser may honestly say.
--
-- Rooms: the daily cap (sql/008) counted rooms by created_at, which the creator could
-- backdate, and a new room could arrive already ended, with its host away, or naming
-- someone else as stand-in host. Now the database sets all of that itself, and a
-- browser may only choose the code and PIN.
--
-- Focus sessions: mode, time and length came straight from the browser, so anyone
-- could add hours of focus, future dates or made-up modes to their streak and to the
-- stats. Now the time is the database's, the mode is one Flow writes, one session is
-- at most a full focus block (120 minutes, plus a little slack), and one account
-- can't log more than 24 hours of focus, or 500 sessions, in any 24 hours.
--
-- Run after sql/023. Repeatable. Running sql/008 again afterwards brings back its
-- older rooms_guard(): run this one again after it.

-- ── Rooms ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rooms_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF; -- migrations and the SQL editor are not users
  NEW.created_by := auth.uid();                   -- never taken from the client
  NEW.created_at := now();                        -- so the daily cap can't be dodged
  NEW.ended_at := NULL;                           -- a new room is live, its host here, with no stand-in
  NEW.host_away := false;
  NEW.acting_host := NULL;
  NEW.acting_seen := NULL;
  NEW.timer := NULL;
  IF NEW.room_code !~ '^[A-Z0-9]{6}$' THEN RAISE EXCEPTION 'Invalid room code'; END IF;
  IF NEW.pin IS NOT NULL AND NEW.pin !~ '^[0-9]{4}$' THEN RAISE EXCEPTION 'Invalid PIN'; END IF;
  NEW.is_locked := NEW.pin IS NOT NULL;
  -- One insert per account at a time, so two sent together can't both slip under the cap.
  PERFORM pg_advisory_xact_lock(hashtext('rooms_guard:' || auth.uid()::text));
  IF (SELECT count(*) FROM public.rooms WHERE created_by = auth.uid() AND created_at > now() - interval '1 day') >= 40 THEN
    RAISE EXCEPTION 'Too many rooms created today';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rooms_guard ON public.rooms;
CREATE TRIGGER rooms_guard BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION public.rooms_guard();

-- Only the columns the room form sends (room.ts). The trigger fills in the rest.
REVOKE INSERT ON public.rooms FROM authenticated;
GRANT INSERT (room_code, is_locked, pin) ON public.rooms TO authenticated;

-- ── Focus sessions ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sessions_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  recent_count INT;
  recent_seconds BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF; -- migrations and the SQL editor are not users
  NEW.completed_at := now();                      -- saved as it ends (timer.ts), so never backdated or future
  IF NEW.mode IS NULL OR NEW.mode NOT IN ('focus', 'focus-partial') THEN RAISE EXCEPTION 'Invalid session mode'; END IF;
  IF NEW.duration_seconds IS NULL OR NEW.duration_seconds NOT BETWEEN 1 AND 7500 THEN RAISE EXCEPTION 'Invalid session length'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sessions_guard:' || NEW.user_id::text)); -- as for rooms
  SELECT count(*), coalesce(sum(duration_seconds), 0) INTO recent_count, recent_seconds
    FROM public.sessions WHERE user_id = NEW.user_id AND completed_at > now() - interval '1 day';
  IF recent_count >= 500 OR recent_seconds + NEW.duration_seconds > 86400 THEN
    RAISE EXCEPTION 'Too much focus time logged today';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sessions_guard ON public.sessions;
CREATE TRIGGER sessions_guard BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.sessions_guard();
