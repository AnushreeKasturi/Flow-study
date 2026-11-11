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
            run(database, `CREATE SCHEMA auth; CREATE TABLE auth.users(id UUID PRIMARY KEY);
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

            for (const id of [two, three, four]) asUser(id, `INSERT INTO public.reports(kind,target,reason) VALUES('planned','${planId}','Not about studying');`);
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
        } finally {
            run('postgres', 'DROP DATABASE ' + database + ' WITH (FORCE);');
        }
    });
});
