// Focused migration drill on a disposable PostgreSQL database, including legacy token preservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const db = process.env.ARGO_PG_TEST_URL;
function sql(query) {
  const result = spawnSync('psql', [db, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1','-v','SHOW_ALL_RESULTS=off'], { input: query, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split('\n').at(-1);
}
test('wood defaults preserve explicit preferences, legacy re-registration and token ownership', { skip: !db }, () => {
  sql(`create schema if not exists auth;
    do $$ begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
    create or replace function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('argo.uid',true),'')::uuid$$;
    grant usage on schema auth, public to authenticated;
    create table public.msgr_push_tokens (token text constraint msgr_push_tokens_pkey primary key, user_id uuid not null, platform text, device text, updated_at timestamptz default now());`);
  sql(readFileSync(new URL('../supabase/migrations/20260912170000_msgr_push_sound.sql', import.meta.url), 'utf8'));
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const register = (uid, token, sound = null) => sql(`set role authenticated; select set_config('argo.uid','${uid}',false); select public.msgr_push_register('ios','${token}','fixture',${sound === null ? 'null' : `'${sound}'`});`);
  register(owner, 'existing-token-123456', 'seatbelt-hilo');
  sql(readFileSync(new URL('../supabase/migrations/20260913160000_msgr_wood_sound_default.sql', import.meta.url), 'utf8'));
  const sound = token => sql(`select sound from public.msgr_push_tokens where token='${token}'`);
  assert.equal(sound('existing-token-123456'), 'seatbelt-hilo', 'migration must not rewrite saved rows');
  register(owner, 'new-token-1234567890'); assert.equal(sound('new-token-1234567890'), 'wood-knock');
  register(owner, 'existing-token-123456'); assert.equal(sound('existing-token-123456'), 'seatbelt-hilo', 'old client without sound must preserve own preference');
  register(owner, 'existing-token-123456', 'wood-marimba'); assert.equal(sound('existing-token-123456'), 'wood-marimba');
  register(other, 'existing-token-123456'); assert.equal(sound('existing-token-123456'), 'wood-knock', 'new account must not inherit prior owner setting');
  sql(`insert into public.msgr_push_tokens(token,user_id,platform) values ('column-default-12345','${owner}','ios')`);
  assert.equal(sound('column-default-12345'), 'wood-knock');
  assert.equal(sql(`select has_function_privilege('public','public.msgr_push_register(text,text,text,text)','execute')`), 'f');
});
