-- Fix: room channels refused their own members after sql/010.
-- 010's channel rules read rooms.ended_at directly, and signed-in users are not
-- granted that column, so every check failed and no one could join a room's
-- live channel. These rules ask room_is_open() instead, which may read it.
-- Run in the Supabase SQL editor. Repeatable. Takes effect immediately.

DROP POLICY IF EXISTS flow_room_receive ON realtime.messages;
CREATE POLICY flow_room_receive ON realtime.messages FOR SELECT TO authenticated USING (
    realtime.messages.extension IN ('broadcast', 'presence') AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic())
          AND public.room_is_open(p.room_id)
    )
);

DROP POLICY IF EXISTS flow_room_send ON realtime.messages;
CREATE POLICY flow_room_send ON realtime.messages FOR INSERT TO authenticated WITH CHECK (
    realtime.messages.extension = 'presence' AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic())
          AND public.room_is_open(p.room_id)
    )
);
