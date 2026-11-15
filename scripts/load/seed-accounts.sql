-- Load-test accounts for a separate Supabase project (never production).
-- Replace PASSWORD_HERE with the password you'll pass to k6 as LOAD_PASSWORD, then run
-- this in that project's SQL editor after sql/schema.sql and every numbered migration.
-- Creates load0001@example.test … load0400@example.test: confirmed (no emails are sent),
-- a month old, and named, like real accounts that have finished setup.
with made as (
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
  select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    format('load%s@example.test', lpad(n::text, 4, '0')),
    extensions.crypt('PASSWORD_HERE', extensions.gen_salt('bf', 6)), now(),
    '{"provider":"email","providers":["email"]}', '{}', now() - interval '30 days', now(), '', '', '', ''
  from generate_series(1, 400) as n
  on conflict do nothing
  returning id, email
), ids as (
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select gen_random_uuid(), id, id::text, json_build_object('sub', id::text, 'email', email, 'email_verified', true), 'email', now(), now(), now()
  from made returning user_id
)
insert into public.profiles (id, display_name)
select id, 'Load ' || substring(email from 5 for 4) from made
on conflict (id) do update set display_name = excluded.display_name;
