// Uses only throwaway databases on the local /tmp test PostgreSQL instance.
// FLOW_TEST_PGPORT=55439 node --test scripts/sql-integration.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const port = process.env.FLOW_TEST_PGPORT || '55439';
const args = ['-h', '127.0.0.1', '-p', port, '-U', 'flow_test', '-v', 'ON_ERROR_STOP=1', '-tA'];
const run = (database, sql) => execFileSync('psql', [...args, '-d', database], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const one = '11111111-1111-4111-8111-111111111111';
const two = '22222222-2222-4222-8222-222222222222';
const room = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('compatibility migration on legacy TEXT and current UUID schemas', async t => {
    assert.equal(run('postgres', 'SELECT current_user;').trim(), 'flow_test');
    run('postgres', "DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
    for (const variant of ['legacy', 'current']) await t.test(variant, () => {
        const database = 'flow_ui_' + variant + '_' + process.pid;
        run('postgres', 'CREATE DATABASE ' + database + ';');
        try {
            run(database, `CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now() - interval '30 days');
                CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
                GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;
                INSERT INTO auth.users VALUES ('${one}'), ('${two}');`);
            if (variant === 'current') run(database, readFileSync('sql/schema.sql', 'utf8'));
            else run(database, `
                CREATE TABLE public.rooms(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), room_code TEXT UNIQUE NOT NULL, is_locked BOOLEAN DEFAULT false, pin TEXT, created_at TIMESTAMPTZ DEFAULT now());
                CREATE TABLE public.tasks(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), room_id TEXT NOT NULL, title TEXT NOT NULL, completed BOOLEAN DEFAULT false, created_by UUID REFERENCES auth.users(id), created_at TIMESTAMPTZ DEFAULT now());
                CREATE TABLE public.sessions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), room_id TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id), mode TEXT, duration_seconds INT, completed_at TIMESTAMPTZ DEFAULT now());
                ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY; ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
                GRANT ALL ON public.rooms, public.tasks, public.sessions TO authenticated;
                GRANT SELECT ON public.tasks TO anon;
                CREATE POLICY legacy_tasks ON public.tasks FOR ALL USING(true) WITH CHECK(true);
                CREATE POLICY legacy_rooms ON public.rooms FOR SELECT USING(true);
                CREATE FUNCTION public.verify_room_pin(TEXT,TEXT) RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER AS $$ SELECT true $$;
                CREATE PUBLICATION supabase_realtime FOR TABLE public.rooms;`);
            run(database, readFileSync('sql/002_profiles.sql', 'utf8'));
            run(database, readFileSync('sql/003_task_assignment.sql', 'utf8'));
            const reference = variant === 'legacy' ? 'FOCUS6' : room;
            run(database, `INSERT INTO public.rooms(id,room_code,is_locked,pin) VALUES('${room}','FOCUS6',true,'1234');
                INSERT INTO public.tasks(room_id,title,created_by) VALUES('${reference}','Retained task','${one}');
                INSERT INTO public.sessions(room_id,user_id,mode,duration_seconds) VALUES('${reference}','${one}','focus',1500);`);
            if (variant === 'current') run(database, 'ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;');
            const migration = readFileSync('sql/004_room_access_compatibility.sql', 'utf8');
            run(database, migration);
            run(database, migration);
            const asUser = (id, sql) => run(database, `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${id}',false); ${sql}`).trim().split('\n').at(-1);
            assert.equal(run(database, 'SELECT count(*) FROM public.tasks;').trim(), '1');
            assert.equal(run(database, 'SELECT count(*) FROM public.sessions;').trim(), '1');
            assert.equal(run(database, 'SELECT room_id::text FROM public.tasks;').trim(), room);
            assert.equal(asUser(one, 'SELECT count(*) FROM public.tasks;'), '1', 'Existing author keeps access');
            assert.equal(asUser(two, 'SELECT count(*) FROM public.tasks;'), '0', 'Outsider cannot read tasks');
            assert.throws(() => asUser(two, "SELECT public.join_room('FOCUS6','0000');"), /Command failed/, 'Wrong PIN must fail');
            assert.throws(() => asUser(two, 'SELECT pin FROM public.rooms;'), /Command failed/, 'PIN must be hidden');
            assert.throws(() => run(database, "SET ROLE anon; SELECT public.join_room('FOCUS6','1234');"), /Command failed/);
            assert.equal(asUser(two, "SELECT public.join_room('focus6','1234');"), room);
            assert.equal(asUser(two, 'SELECT count(*) FROM public.tasks;'), '1', 'Joined user can read tasks');
            assert.throws(() => asUser(two, `INSERT INTO public.tasks(room_id,title,created_by) VALUES('${room}','Spoofed author','${one}');`), /Command failed/);
            asUser(two, `INSERT INTO public.tasks(room_id,title,created_by) VALUES('${room}','Valid task','${two}');`);
            assert.equal(run(database, "SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime';").trim(), '2', 'Existing publication members survive');

            // 005: size limits and the study-groups board. Run twice to prove it is repeatable.
            const board = readFileSync('sql/005_open_rooms_and_limits.sql', 'utf8');
            run(database, board);
            run(database, board);
            assert.throws(() => asUser(two, `INSERT INTO public.tasks(room_id,title,created_by) VALUES('${room}',repeat('x',201),'${two}');`), /Command failed/, 'Oversized task titles are refused');
            assert.equal(run(database, 'SELECT count(*) FROM public.tasks;').trim(), '2', 'Existing tasks survive the new limits');
            const openRoom = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
            const three = '33333333-3333-4333-8333-333333333333';
            run(database, `INSERT INTO auth.users VALUES ('${three}'); INSERT INTO public.rooms(id,room_code,is_locked) VALUES('${openRoom}','OPEN22',false);`);
            const list = (id, roomId, extra = '') => asUser(id, `INSERT INTO public.open_rooms(room_id,host_name,topic,seats${extra ? ',host_id' : ''}) VALUES('${roomId}','Alex','Organic chemistry revision',2${extra});`);
            assert.throws(() => list(one, openRoom), /Command failed/, 'Only someone in the room may list it');
            asUser(one, "SELECT public.join_room('OPEN22', NULL);");
            assert.throws(() => list(two, room), /Command failed/, 'A PIN-locked room cannot be listed');
            assert.throws(() => list(one, openRoom, `,'${two}'`), /Command failed/, 'A listing cannot be created in someone else\'s name');
            list(one, openRoom);
            assert.throws(() => asUser(two, 'SELECT room_id FROM public.open_rooms;'), /Command failed/, 'The room id stays hidden from the board');
            // The app must list with delete-then-insert. An upsert reads the hidden room_id and is refused,
            // which is exactly how listing was broken in production.
            assert.throws(() => asUser(one, `INSERT INTO public.open_rooms(host_id,room_id,host_name,topic,seats) VALUES('${one}','${openRoom}','Alex','Upserted',2) ON CONFLICT (host_id) DO UPDATE SET room_id = EXCLUDED.room_id, topic = EXCLUDED.topic;`), /Command failed/, 'Upserts are refused because room_id is unreadable');
            asUser(one, `DELETE FROM public.open_rooms WHERE host_id = '${one}'; INSERT INTO public.open_rooms(host_id,room_id,host_name,topic,seats,seats_taken) VALUES('${one}','${openRoom}','Alex','Organic chemistry revision',2,1);`);
            assert.equal(run(database, 'SELECT count(*) FROM public.open_rooms;').trim(), '1', 'Delete-then-insert replaces the listing');
            const listing = asUser(two, 'SELECT id FROM public.open_rooms;');
            assert.match(listing, /^[0-9a-f-]{36}$/, 'Signed-in users see fresh listings');
            assert.throws(() => run(database, `SET ROLE anon; SELECT public.join_open_room('${listing}');`), /Command failed/, 'Signed-out callers cannot take a seat');
            assert.equal(asUser(two, `SELECT public.join_open_room('${listing}');`), 'OPEN22', 'A free seat returns the room code');
            assert.equal(asUser(two, `SELECT public.join_open_room('${listing}');`), 'OPEN22', 'Rejoining does not take a second seat');
            assert.equal(run(database, 'SELECT seats_taken FROM public.open_rooms;').trim(), '2');
            assert.throws(() => asUser(three, `SELECT public.join_open_room('${listing}');`), /Command failed/, 'A full group refuses another seat');
            asUser(two, "UPDATE public.open_rooms SET topic = 'Taken over';");
            assert.equal(run(database, 'SELECT topic FROM public.open_rooms;').trim(), 'Organic chemistry revision', 'Only the host may edit a listing');
            assert.throws(() => asUser(one, "UPDATE public.open_rooms SET last_seen = now() + interval '1 year';"), /Command failed/, 'A host cannot post-date their listing');
            run(database, "UPDATE public.open_rooms SET last_seen = now() - interval '5 minutes';");
            asUser(one, 'UPDATE public.open_rooms SET seats_taken = 1;');
            assert.equal(asUser(two, 'SELECT count(*) FROM public.open_rooms;'), '1', 'The host refreshing brings the listing back');
            run(database, "UPDATE public.open_rooms SET last_seen = now() - interval '5 minutes';");
            assert.equal(asUser(two, 'SELECT count(*) FROM public.open_rooms;'), '0', 'Stale listings disappear from the board');
            assert.equal(asUser(one, 'SELECT count(*) FROM public.open_rooms;'), '1', 'The host still sees their own listing');

            // 006: board v2, host controls, reports. Run twice to prove it is repeatable.
            const v2 = readFileSync('sql/006_board_v2_and_host_controls.sql', 'utf8');
            run(database, v2);
            run(database, v2);
            const four = '44444444-4444-4444-8444-444444444444';
            const asAnon = sql => run(database, 'SET ROLE anon; ' + sql).trim().split('\n').at(-1);
            run(database, `INSERT INTO auth.users VALUES ('${four}'); UPDATE public.open_rooms SET last_seen = now(); UPDATE public.rooms SET created_by = '${one}' WHERE id = '${openRoom}';`);
            assert.equal(asAnon('SELECT count(*) FROM public.open_rooms;'), '1', 'Visitors can read the board');
            assert.throws(() => asAnon('SELECT room_id FROM public.open_rooms;'), /Command failed/, 'Visitors never see room ids');
            assert.throws(() => asAnon(`SELECT public.join_open_room('${listing}');`), /Command failed/, 'Visitors cannot take a seat');
            asUser(one, 'UPDATE public.open_rooms SET seats_taken = 2;'); // both seats of this two-seat listing are in use
            assert.throws(() => asUser(three, "SELECT public.join_room('OPEN22', NULL);"), /Command failed/, 'A full listed room also refuses joins by code');
            asUser(one, "UPDATE public.open_rooms SET seats = 4, subject = 'science', camera = 'off', timer_mode = 'focus';");
            assert.throws(() => asUser(one, "UPDATE public.open_rooms SET subject = 'gossip';"), /Command failed/, 'Subjects come from the fixed list');
            assert.throws(() => asUser(two, `INSERT INTO public.open_rooms(room_id,host_name,topic,seats) VALUES('${openRoom}','Mallory','Second listing',6);`), /Command failed/, 'Only the room\'s creator may list it, and only once');
            assert.equal(asUser(three, "SELECT public.join_room('OPEN22', NULL);"), openRoom, 'A free seat lets a code join through');
            asUser(one, 'UPDATE public.open_rooms SET closed = true;');
            assert.throws(() => asUser(four, `SELECT public.join_open_room('${listing}');`), /Command failed/, 'Closed seats refuse newcomers');
            assert.throws(() => asUser(four, "SELECT public.join_room('OPEN22', NULL);"), /Command failed/, 'Closed seats also refuse joins by code');
            assert.equal(asUser(two, `SELECT public.join_open_room('${listing}');`), 'OPEN22', 'People already in the room can come back');

            assert.throws(() => asUser(two, `SELECT public.remove_participant('${openRoom}','${three}');`), /Command failed/, 'Only the host can remove someone');
            assert.throws(() => asUser(one, `SELECT public.remove_participant('${openRoom}','${one}');`), /Command failed/, 'The host cannot remove themselves');
            asUser(one, `SELECT public.remove_participant('${openRoom}','${three}');`);
            assert.equal(run(database, `SELECT count(*) FROM public.room_participants WHERE room_id = '${openRoom}' AND user_id = '${three}';`).trim(), '0');
            asUser(one, 'UPDATE public.open_rooms SET closed = false;');
            assert.throws(() => asUser(three, "SELECT public.join_room('OPEN22', NULL);"), /Command failed/, 'Someone removed cannot rejoin by code');
            assert.throws(() => asUser(three, `SELECT public.join_open_room('${listing}');`), /Command failed/, 'Someone removed cannot rejoin from the board');
            assert.equal(asUser(two, "SELECT public.join_room('focus6','1234');"), room, 'Existing PIN rooms still work');

            const plan = (id, when) => asUser(id, `INSERT INTO public.planned_groups(host_name,topic,seats,starts_at) VALUES('Alex','Evening calculus',4, now() + interval '${when}');`);
            plan(one, '3 hours');
            assert.throws(() => plan(one, '-1 day'), /Command failed/, 'A plan cannot start in the past');
            assert.throws(() => plan(one, '30 days'), /Command failed/, 'A plan cannot be more than two weeks out');
            const planId = asAnon('SELECT id FROM public.planned_groups;');
            assert.match(planId, /^[0-9a-f-]{36}$/, 'Visitors can read planned groups');
            asUser(two, `INSERT INTO public.planned_group_members(group_id) VALUES('${planId}');`);
            asUser(one, `INSERT INTO public.planned_group_members(group_id) VALUES('${planId}');`);
            assert.equal(run(database, 'SELECT going FROM public.planned_groups;').trim(), '2', 'Going counts the host once plus everyone in');
            assert.throws(() => asUser(two, 'UPDATE public.planned_groups SET going = 99;'), /Command failed/, 'Going is never set by clients');
            assert.throws(() => asUser(two, `INSERT INTO public.planned_group_members(group_id,user_id) VALUES('${planId}','${three}');`), /Command failed/, 'Nobody can sign someone else up');
            asUser(two, `DELETE FROM public.planned_group_members WHERE group_id = '${planId}';`);
            assert.equal(run(database, 'SELECT going FROM public.planned_groups;').trim(), '1');
            plan(one, '4 hours'); plan(one, '5 hours');
            assert.throws(() => plan(one, '6 hours'), /Command failed/, 'A host is limited to three plans ahead');
            asUser(two, `DELETE FROM public.planned_groups WHERE id = '${planId}';`);
            assert.equal(run(database, 'SELECT count(*) FROM public.planned_groups;').trim(), '3', 'Only the host can cancel a plan');

            // Three reporters hide a host, but an account made today does not count toward the three.
            const fresh = '55555555-5555-4555-8555-555555555555';
            run(database, `INSERT INTO auth.users(id, created_at) VALUES ('${fresh}', now());`);
            for (const id of [fresh, two, three]) asUser(id, `INSERT INTO public.reports(kind,target,reason) VALUES('planned','${planId}','Not about studying');`);
            assert.equal(asUser(two, 'SELECT count(*) FROM public.planned_groups;'), '3', 'Two established reporters plus a brand-new account are not enough');
            assert.equal(run(database, 'SELECT count(*) FROM public.reports;').trim(), '3', 'Every report is still recorded');
            asUser(four, `INSERT INTO public.reports(kind,target,reason) VALUES('planned','${planId}','Not about studying');`);
            assert.throws(() => asUser(two, `INSERT INTO public.reports(kind,target) VALUES('planned','${planId}');`), /Command failed/, 'One report per person per listing');
            assert.throws(() => asUser(two, 'SELECT count(*) FROM public.reports;'), /Command failed/, 'Reports are write-only for users');
            assert.throws(() => asUser(one, `INSERT INTO public.reports(kind,target) VALUES('planned','${planId}');`), /Command failed/, 'A host cannot report themselves');
            assert.throws(() => asUser(two, "INSERT INTO public.reports(kind,target) VALUES('planned','99999999-9999-4999-8999-999999999999');"), /Command failed/, 'A report must point at a real listing');
            assert.equal(asUser(two, 'SELECT count(*) FROM public.planned_groups;'), '0', 'Three reporters hide everything that host has planned');
            assert.equal(asUser(two, 'SELECT count(*) FROM public.open_rooms;'), '0', 'and their open room');
            assert.equal(asUser(one, 'SELECT count(*) FROM public.planned_groups;'), '3', 'The host still sees their own');
            asUser(one, `DELETE FROM public.planned_groups WHERE id = '${planId}';`);
            plan(one, '7 hours');
            assert.equal(asUser(two, 'SELECT count(*) FROM public.planned_groups;'), '0', 'Deleting and posting again does not clear the reports');
            assert.throws(() => asUser(four, `SELECT public.join_open_room('${listing}');`), /Command failed/, 'A flagged host\'s room cannot be joined from the board');
            assert.equal(run(database, "SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename IN ('open_rooms','planned_groups');").trim(), '2', 'The board tables publish changes');

            // 008: security hardening. A stand-in for Supabase's realtime.send records what would be broadcast.
            // Stand-ins for Supabase's realtime schema: the messages table its channel rules guard,
            // and the function that names the channel being joined.
            run(database, `CREATE SCHEMA IF NOT EXISTS realtime;
                CREATE TABLE IF NOT EXISTS realtime.messages(topic TEXT, extension TEXT, payload JSONB);
                ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
                GRANT USAGE ON SCHEMA realtime TO authenticated, anon;
                GRANT SELECT, INSERT ON realtime.messages TO authenticated, anon;
                CREATE OR REPLACE FUNCTION realtime.topic() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;`);
            run(database, `CREATE SCHEMA IF NOT EXISTS realtime; CREATE TABLE IF NOT EXISTS realtime.sent(payload JSONB, event TEXT, topic TEXT, private BOOLEAN);
                CREATE OR REPLACE FUNCTION realtime.send(payload JSONB, event TEXT, topic TEXT, private BOOLEAN DEFAULT true) RETURNS VOID LANGUAGE SQL AS $$ INSERT INTO realtime.sent VALUES (payload, event, topic, private) $$;`);
            const hardening = readFileSync('sql/008_security_hardening.sql', 'utf8');
            run(database, hardening);
            run(database, hardening);
            const stranger = '66666666-6666-4666-8666-666666666666';
            run(database, `INSERT INTO auth.users VALUES ('${stranger}');`);
            // Rooms are no longer listable by anyone signed in.
            assert.equal(asUser(stranger, 'SELECT count(*) FROM public.rooms;'), '0', 'A stranger sees no rooms');
            assert.equal(asUser(two, `SELECT count(*) FROM public.rooms WHERE id = '${openRoom}';`), '1', 'A member sees their room');
            assert.throws(() => asAnon('SELECT count(*) FROM public.rooms;'), /Command failed/, 'Visitors cannot read rooms at all');
            // Creating rooms: the database decides the creator and the lock, and rejects bad codes.
            asUser(stranger, `INSERT INTO public.rooms(room_code, is_locked, pin, created_by) VALUES('NEWONE', false, '4321', '${one}');`);
            assert.equal(run(database, "SELECT created_by::text || ' ' || is_locked FROM public.rooms WHERE room_code = 'NEWONE';").trim(), stranger + ' true', 'Creator and lock are set by the database');
            assert.throws(() => asUser(stranger, "INSERT INTO public.rooms(room_code) VALUES('bad code');"), /Command failed/, 'Room codes must be six capitals or digits');
            assert.throws(() => asUser(stranger, "INSERT INTO public.rooms(room_code, pin) VALUES('PINBAD', 'abcd');"), /Command failed/, 'PINs must be four digits');
            // Joining: misses return nothing, are counted, and lock the account out after ten.
            assert.equal(asUser(stranger, "SELECT public.join_room('NOPE00', NULL) IS NULL;"), 't', 'A wrong code returns nothing');
            assert.equal(asUser(stranger, "SELECT public.join_room('NEWONE', '0000') IS NULL;"), 't', 'A wrong PIN returns nothing, the same as a wrong code');
            assert.equal(asUser(stranger, "SELECT public.join_room('NEWONE', '4321') IS NOT NULL;"), 't', 'The right PIN still works');
            for (let attempt = 0; attempt < 8; attempt++) asUser(stranger, "SELECT public.join_room('NOPE00', NULL);");
            assert.throws(() => asUser(stranger, "SELECT public.join_room('NEWONE', '4321');"), /Command failed/, 'Ten misses lock joining, even with the right PIN');
            assert.equal(asUser(two, "SELECT public.join_room('focus6','1234');"), room, 'Other accounts are unaffected');
            assert.throws(() => asUser(stranger, 'SELECT count(*) FROM public.join_failures;'), /Command failed/, 'The failure log is not readable');
            // A PIN room is also protected across accounts: twenty wrong PINs close it to newcomers for a while.
            run(database, 'DELETE FROM public.join_failures;'); // start the count clean: earlier checks in this test also guessed wrong
            for (const guesser of [two, three, four]) for (let attempt = 0; attempt < 10; attempt++) asUser(guesser, "SELECT public.join_room('NEWONE', '0000');");
            assert.equal(run(database, "SELECT count(*) FROM realtime.sent WHERE event = 'notice' AND topic = 'room:' || (SELECT id FROM public.rooms WHERE room_code = 'NEWONE');").trim(), '1', 'The room is told when its PIN is being guessed');
            assert.throws(() => asUser(fresh, "SELECT public.join_room('NEWONE', '4321');"), /Command failed/, 'A room under PIN guessing refuses newcomers, even with the right PIN');
            run(database, 'DELETE FROM public.join_failures;');
            assert.equal(asUser(fresh, "SELECT public.join_room('NEWONE', '4321') IS NOT NULL;"), 't', 'and opens again when the window passes');
            assert.equal(asUser(fresh, "SELECT public.join_room('NEWONE', NULL) IS NOT NULL;"), 't', 'Someone already in a PIN room is not asked for it again');
            // Stored data limits.
            assert.throws(() => asUser(two, `INSERT INTO public.sessions(room_id,user_id,mode,duration_seconds) VALUES('${variant === 'legacy' ? room : room}','${two}','focus',999999);`), /Command failed/, 'Absurd focus sessions are refused');
            // The API quota counts per account and says no when it is used up.
            for (let call = 0; call < 10; call++) assert.equal(asUser(two, "SELECT public.api_allow('ai');"), 't');
            assert.equal(asUser(two, "SELECT public.api_allow('ai');"), 'f', 'The eleventh assistant call in a minute is refused');
            assert.equal(asUser(three, "SELECT public.api_allow('ai');"), 't', 'Quotas are per account');
            assert.throws(() => asAnon("SELECT public.api_allow('ai');"), /Command failed/, 'Signed-out callers have no quota');
            assert.throws(() => asUser(two, "SELECT public.api_allow('free-for-all');"), /Command failed/);
            // Room messages: members only, known kinds only, and the sender is stamped by the database.
            asUser(two, `SELECT public.room_send('${openRoom}', 'chat-message', '{"sender":"Sam","text":"hi","from":"${one}"}');`);
            assert.equal(run(database, "SELECT (payload->>'from') || ' ' || topic || ' ' || private FROM realtime.sent;").trim(), two + ' room:' + openRoom + ' true', 'A forged sender is overwritten with the real one');
            assert.throws(() => asUser(stranger, `SELECT public.room_send('${openRoom}', 'chat-message', '{"text":"let me in"}');`), /Command failed/, 'Non-members cannot send');
            assert.throws(() => asUser(two, `SELECT public.room_send('${openRoom}', 'made-up', '{}');`), /Command failed/, 'Unknown kinds of message are refused');
            assert.throws(() => asUser(two, `SELECT public.room_send('${openRoom}', 'removed', '{"userId":"${one}"}');`), /Command failed/, 'Only the host can announce a removal');
            asUser(one, `SELECT public.room_send('${openRoom}', 'removed', '{"userId":"${three}"}');`);
            assert.throws(() => asUser(two, `SELECT public.room_send('${openRoom}', 'chat-message', '"not an object"');`), /Command failed/);

            // 010: host handover, ending a room, and the board's live ping.
            const handover = readFileSync('sql/010_host_handover_and_live_board.sql', 'utf8');
            run(database, handover);
            run(database, handover);
            run(database, `UPDATE public.open_rooms SET last_seen = now(), closed = false, seats = 6; INSERT INTO public.profiles(id, display_name) VALUES ('${two}', 'Sam') ON CONFLICT (id) DO UPDATE SET display_name = 'Sam'; DELETE FROM realtime.sent;`);
            assert.throws(() => asUser(two, `SELECT public.transfer_host('${openRoom}', '${two}');`), /Command failed/, 'Only the host can hand over');
            assert.throws(() => asUser(one, `SELECT public.transfer_host('${openRoom}', '${stranger}');`), /Command failed/, 'The new host must be in the room');
            assert.throws(() => asUser(one, `SELECT public.transfer_host('${openRoom}', '${three}');`), /Command failed/, 'Someone removed cannot become host');
            // Someone who already lists another room keeps that listing; this room comes off the board instead.
            const otherRoom = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
            run(database, `INSERT INTO public.rooms(id,room_code,is_locked,created_by) VALUES('${otherRoom}','OTHER3',false,'${fresh}');
                INSERT INTO public.room_participants(room_id,user_id) VALUES ('${otherRoom}','${fresh}'), ('${openRoom}','${fresh}');
                INSERT INTO public.open_rooms(host_id,room_id,host_name,topic,seats) VALUES('${fresh}','${otherRoom}','Kai','Kai''s own group',4);`);
            asUser(one, `SELECT public.transfer_host('${openRoom}', '${fresh}');`);
            assert.equal(run(database, `SELECT count(*) FROM public.open_rooms WHERE room_id = '${openRoom}';`).trim(), '0', 'This room comes off the board');
            assert.equal(run(database, `SELECT topic FROM public.open_rooms WHERE host_id = '${fresh}';`).trim(), "Kai's own group", 'Their own listing is left alone');
            asUser(fresh, `SELECT public.transfer_host('${openRoom}', '${one}');`);
            run(database, `INSERT INTO public.open_rooms(host_id,room_id,host_name,topic,seats) VALUES('${one}','${openRoom}','Alex','Organic chemistry revision',6); DELETE FROM realtime.sent; UPDATE public.board_ping SET at = 'epoch';`);
            assert.equal(asUser(one, `SELECT public.transfer_host('${openRoom}', '${two}');`), 'Sam', 'Handing over returns the new host\'s name');
            assert.equal(run(database, `SELECT created_by::text FROM public.rooms WHERE id = '${openRoom}';`).trim(), two, 'The room has a new host');
            assert.equal(run(database, `SELECT host_id::text || ' ' || host_name FROM public.open_rooms WHERE room_id = '${openRoom}';`).trim(), two + ' Sam', 'The listing follows the new host, under their name');
            assert.equal(run(database, "SELECT count(*) FROM realtime.sent WHERE event = 'host-changed' AND payload->>'name' = 'Sam';").trim(), '1', 'The room is told who the host is now');
            assert.notEqual(run(database, "SELECT count(*) FROM realtime.sent WHERE topic = 'board' AND event = 'changed';").trim(), '0', 'The board is pinged when a listing changes');
            // A statement that changes nothing sends nothing; real changes are throttled.
            run(database, "DELETE FROM realtime.sent WHERE topic = 'board'; UPDATE public.board_ping SET at = 'epoch';");
            asUser(one, "UPDATE public.open_rooms SET topic = 'Nothing' WHERE host_id = '00000000-0000-4000-8000-000000000000';");
            assert.equal(run(database, "SELECT count(*) FROM realtime.sent WHERE topic = 'board';").trim(), '0', 'An update that changes no rows does not ping');
            asUser(two, "UPDATE public.open_rooms SET seats = 5; UPDATE public.open_rooms SET seats = 4; UPDATE public.open_rooms SET seats = 6;");
            assert.equal(run(database, "SELECT count(*) FROM realtime.sent WHERE topic = 'board';").trim(), '1', 'A burst of changes sends one ping');
            assert.throws(() => asUser(one, `SELECT public.end_room('${openRoom}');`), /Command failed/, 'The old host can no longer end the room');
            run(database, `INSERT INTO public.sessions(room_id,user_id,mode,duration_seconds) VALUES('${openRoom}','${one}','focus',600);`);
            asUser(two, `SELECT public.end_room('${openRoom}');`);
            assert.equal(run(database, `SELECT count(*) FROM public.open_rooms WHERE room_id = '${openRoom}';`).trim(), '0', 'Ending a room takes it off the board');
            assert.equal(run(database, "SELECT count(*) FROM realtime.sent WHERE event = 'room-ended';").trim(), '1', 'Everyone in the room is told');
            assert.throws(() => asUser(one, "SELECT public.join_room('OPEN22', NULL);"), /Command failed/, 'An ended room cannot be joined, even by its members');
            assert.throws(() => asUser(one, `SELECT public.room_send('${openRoom}', 'chat-message', '{"text":"hello?"}');`), /Command failed/, 'Nothing more can be sent into an ended room');
            assert.throws(() => asUser(two, `SELECT public.transfer_host('${openRoom}', '${one}');`), /Command failed/, 'An ended room cannot change hands');
            assert.equal(asUser(one, `SELECT count(*) FROM public.sessions WHERE room_id = '${openRoom}';`), '1', 'Focus history from an ended room is kept');

            // 011: the channel rules, as a member meets them. (010's version refused every member.)
            run(database, readFileSync('sql/011_fix_room_channel_access.sql', 'utf8'));
            const channel = (id, topic, sql) => run(database, `SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${id}',false); SELECT set_config('realtime.topic','${topic}',false); ${sql}`).trim().split('\n').at(-1);
            run(database, `INSERT INTO realtime.messages VALUES ('room:${room}','broadcast','{}'), ('room:${openRoom}','broadcast','{}'), ('board','broadcast','{}');`);
            assert.equal(channel(two, 'room:' + room, `SELECT count(*) FROM realtime.messages WHERE topic = 'room:${room}';`), '1', 'A member can listen on their room\'s channel');
            assert.equal(channel(stranger, 'room:' + room, `SELECT count(*) FROM realtime.messages WHERE topic = 'room:${room}';`), '0', 'Someone outside the room cannot');
            assert.equal(channel(one, 'room:' + openRoom, `SELECT count(*) FROM realtime.messages WHERE topic = 'room:${openRoom}';`), '0', 'Nobody can listen on an ended room');
            assert.equal(channel(stranger, 'board', "SELECT count(*) FROM realtime.messages WHERE topic = 'board';"), '1', 'Anyone signed in can listen on the board');
            assert.throws(() => channel(stranger, 'board', "INSERT INTO realtime.messages VALUES ('board','broadcast','{}');"), /Command failed/, 'Nobody can send on the board');
            channel(two, 'room:' + room, `INSERT INTO realtime.messages VALUES ('room:${room}','presence','{}');`);
            assert.throws(() => channel(two, 'room:' + room, `INSERT INTO realtime.messages VALUES ('room:${room}','broadcast','{}');`), /Command failed/, 'Members announce presence directly, but broadcast only through room_send');

            // 012: the host steps away; one person hosts for now; the host gets it back on return.
            const migration012 = readFileSync('sql/012_temporary_host.sql', 'utf8');
            run(database, migration012);
            run(database, migration012);
            const hostFor = sql => run(database, `SELECT ${sql} FROM public.rooms WHERE id = '${otherRoom}';`).trim();
            const fn = (id, name) => asUser(id, `SELECT public.${name}('${otherRoom}');`);
            run(database, `INSERT INTO public.room_participants(room_id,user_id) VALUES ('${otherRoom}','${two}'), ('${otherRoom}','${stranger}');`);
            assert.throws(() => fn(two, 'step_away'), /Command failed/, 'Only the host can step away');
            assert.equal(fn(two, 'claim_host'), 'f', 'Nobody stands in while the host is here');
            fn(fresh, 'step_away');
            run(database, `UPDATE public.open_rooms SET last_seen = now() - interval '1 hour' WHERE room_id = '${otherRoom}';`);
            assert.equal(run(database, "SET ROLE anon; SELECT count(*) FROM public.open_rooms WHERE topic = 'Kai''s own group';").trim().split('\n').at(-1), '1', 'An away host\'s listing stays on the board');
            assert.equal(fn(two, 'claim_host'), 't', 'The first person in hosts for now');
            assert.equal(fn(stranger, 'claim_host'), 'f', 'Only one person hosts at a time');
            assert.equal(run(database, `SELECT acting_name FROM public.open_rooms WHERE room_id = '${otherRoom}';`).trim(), 'Sam', 'The board shows who hosts for now');
            assert.equal(asUser(two, `SELECT public.room_checkin('${otherRoom}', 9, 'focus', now() + interval '20 minutes');`), 't');
            assert.equal(run(database, `SELECT seats_taken || ' ' || timer_mode FROM public.open_rooms WHERE room_id = '${otherRoom}';`).trim(), '4 focus', 'The stand-in keeps the listing current, within its seats');
            assert.equal(asUser(stranger, `SELECT public.room_checkin('${otherRoom}', 1, NULL, NULL);`), 'f', 'Only the stand-in checks in');
            assert.throws(() => fn(two, 'end_room'), /Command failed/, 'A stand-in cannot end the room');
            assert.throws(() => asUser(two, `SELECT public.remove_participant('${otherRoom}', '${stranger}');`), /Command failed/, 'A stand-in cannot remove anyone');
            run(database, `UPDATE public.rooms SET acting_seen = now() - interval '2 minutes' WHERE id = '${otherRoom}';`);
            assert.equal(fn(stranger, 'claim_host'), 't', 'A stand-in who has gone quiet is replaced');
            fn(stranger, 'release_host');
            assert.equal(hostFor("acting_host IS NULL AND host_away"), 't', 'Leaving frees the role for the next person');
            assert.equal(fn(two, 'claim_host'), 't');
            run(database, 'DELETE FROM realtime.sent;');
            asUser(fresh, "SELECT public.join_room('OTHER3', NULL);");
            assert.equal(hostFor("host_away::text || ' ' || (acting_host IS NULL)::text"), 'false true', 'The host gets the role back the moment they return');
            assert.equal(run(database, `SELECT (away_until IS NULL AND acting_name IS NULL)::text FROM public.open_rooms WHERE room_id = '${otherRoom}';`).trim(), 'true', 'The listing is theirs again');
            assert.equal(run(database, `SELECT count(*) FROM realtime.sent WHERE event = 'host-changed' AND payload->>'host' = '${fresh}';`).trim(), '1', 'The room is told the host is back');
            assert.equal(fn(stranger, 'claim_host'), 'f', 'Nobody else can take it once the host is back');
            assert.equal(asUser(fresh, `SELECT public.lists_room('${otherRoom}');`), 't', 'The host can tell this room\'s listing is theirs');
            assert.equal(asUser(two, `SELECT public.lists_room('${otherRoom}');`), 'f');

            // 013: a ceiling on the whole project, so many accounts together can't run up the bill.
            const migration013 = readFileSync('sql/013_global_quotas.sql', 'utf8');
            run(database, migration013);
            run(database, migration013);
            run(database, `DELETE FROM public.api_usage; INSERT INTO public.api_usage (user_id, kind, at) SELECT '${one}', 'ai', now() - interval '30 minutes' FROM generate_series(1, 600);`);
            assert.equal(asUser(stranger, "SELECT public.api_allow('ai');"), 'f', 'Past the hourly ceiling, even a fresh account is refused');
            assert.equal(asUser(stranger, "SELECT public.api_allow('turn');"), 't', 'Each kind has its own ceiling');
            run(database, "UPDATE public.api_usage SET at = now() - interval '2 hours' WHERE kind = 'ai';");
            assert.equal(asUser(stranger, "SELECT public.api_allow('ai');"), 't', 'The ceiling is per hour');
            run(database, `DELETE FROM public.api_usage WHERE user_id = '${two}'; INSERT INTO public.api_usage (user_id, kind, at) SELECT '${two}', 'ai', now() - interval '20 minutes' FROM generate_series(1, 30);`);
            assert.equal(asUser(two, "SELECT public.api_allow('ai');"), 'f', 'One account cannot take more than its hourly share of the ceiling');
            assert.equal(run(database, "SELECT count(*) FROM public.api_usage WHERE at < now() - interval '1 day';").trim(), '0', 'Old usage is cleared for everyone, not just the caller');

            const migration014 = readFileSync('sql/014_deny_by_default.sql', 'utf8');
            run(database, migration014);
            run(database, migration014);
            assert.equal(asUser(one, `SELECT count(*) > 0 FROM public.sessions WHERE room_id::text = '${openRoom}';`), 't', 'People still see their own focus history');
            assert.equal(asUser(stranger, 'SELECT count(*) FROM public.sessions;'), '0', 'Nobody sees anyone else\'s');
            run(database, 'SET ROLE anon; SELECT count(*) FROM public.open_rooms, public.planned_groups;'); // the public board stays readable
            assert.throws(() => run(database, 'SET ROLE anon; SELECT count(*) FROM public.profiles;'), /Command failed/, 'Signed-out visitors cannot read profiles');
            // Deny by default: after every migration, each table in public has row-level security,
            // and signed-out visitors can write to nothing.
            assert.equal(run(database, "SELECT string_agg(relname, ', ') FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity;").trim(), '', 'Every table must have row-level security');
            assert.equal(run(database, "SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'public' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');").trim(), '', 'Signed-out visitors can write to nothing');
        } finally {
            run('postgres', 'DROP DATABASE ' + database + ' WITH (FORCE);');
        }
    });
});
