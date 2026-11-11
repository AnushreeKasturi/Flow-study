-- Final step of sender verification. Run this ONLY after 008 is applied, the
-- matching site version is deployed, and rooms have been checked to work
-- (see SECURITY.md, "Verified senders").
--
-- After this, browsers can no longer broadcast into a room channel directly.
-- Every message must come through room_send(), which stamps the real sender.
-- Presence (who is here) still goes directly, because the database cannot send it.
--
-- To undo: run sql/007_private_room_channels.sql again. Repeatable.

DROP POLICY IF EXISTS flow_room_send ON realtime.messages;
CREATE POLICY flow_room_send ON realtime.messages FOR INSERT TO authenticated WITH CHECK (
    realtime.messages.extension = 'presence' AND EXISTS (
        SELECT 1 FROM public.room_participants p
        WHERE p.user_id = (SELECT auth.uid()) AND 'room:' || p.room_id::text = (SELECT realtime.topic())
    )
);
