-- Whether a room is on the public study-groups board right now, for the people in it.
-- Calls in a listed room hide each person's IP address by default, since the others
-- are usually strangers; this tells the browser, without exposing the room's id.
-- Repeatable. Run after 014 in the Supabase SQL editor.
CREATE OR REPLACE FUNCTION public.room_listed(p_room UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.room_participants WHERE room_id = p_room AND user_id = auth.uid())
     AND EXISTS (SELECT 1 FROM public.open_rooms WHERE room_id = p_room AND public.listing_live(last_seen, away_until));
$$;
REVOKE ALL ON FUNCTION public.room_listed(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_listed(UUID) TO authenticated;
