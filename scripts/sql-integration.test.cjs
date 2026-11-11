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
        } finally {
            run('postgres', 'DROP DATABASE ' + database + ' WITH (FORCE);');
        }
    });
});
