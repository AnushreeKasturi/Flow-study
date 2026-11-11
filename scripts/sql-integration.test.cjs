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
            run(database, "UPDATE public.open_rooms SET last_seen = now() - interval '5 minutes';");
            assert.equal(asUser(two, 'SELECT count(*) FROM public.open_rooms;'), '0', 'Stale listings disappear from the board');
            assert.equal(asUser(one, 'SELECT count(*) FROM public.open_rooms;'), '1', 'The host still sees their own listing');
        } finally {
            run('postgres', 'DROP DATABASE ' + database + ' WITH (FORCE);');
        }
    });
});
