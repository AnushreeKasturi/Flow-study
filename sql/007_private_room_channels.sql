-- Private room channels (Supabase Realtime Authorization).
-- Lets only people who joined a room receive or send its presence, chat, timer,
-- and call-setup messages.
--
-- This file is one of four steps and does nothing visible on its own.
-- Follow SECURITY.md, "Turning on private room channels", in order.
-- Repeatable.

DROP POLICY IF EXISTS flow_room_receive ON realtime.messages;
CREATE POLICY flow_room_receive ON realtime.messages FOR SELECT TO authenticated USING (
    realtime.messages.extension IN ('broadcast', 'presence') AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic())
    )
);

DROP POLICY IF EXISTS flow_room_send ON realtime.messages;
CREATE POLICY flow_room_send ON realtime.messages FOR INSERT TO authenticated WITH CHECK (
    realtime.messages.extension IN ('broadcast', 'presence') AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic())
    )
);
