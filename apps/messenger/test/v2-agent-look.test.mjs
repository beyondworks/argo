// v2 에이전트 프로필 저장 — 얼굴·사진·직무·소개(0.1.65 결함 3 + 검수 D1, 2026-10-25 유건 아이폰 — "얼굴 저장"을 눌러도 그대로, 직무·소개도 v2_unsupported).
// 원인: 화면은 옛 msgr_crews를 update하는데 v2 조회 어댑터(CrewBuilder)가 모든 쓰기를 v2_unsupported로 막았다. 사진 칸도 읽지 않았다(avatar_url: null 고정).
// 사진(#1163 엄격 검수 B1): DB에는 객체 경로(avatars/<uid>/<파일명>)만 — 어댑터가 자기 프로젝트 공개 주소만 경로로 바꾸고, 읽을 때 경로 → 공개 주소.
// 지금: 얼굴·사진·직무·소개 update는 에이전트마다 msgr2_agent_set_profile(DB 20261025130000) 1회, 목록은 avatar_url을 읽는다(칸이 없는 옛 DB면 빼고 다시 읽는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Client } from '../src/v2/source.mjs';
import { saveAgentLook, fillAgentLooks } from '../src/agent-groups.mjs';
import { readFileSync } from 'node:fs';

const ME = 'e2000000-0000-4000-8000-00000000000a';
const BASE = 'https://p.supabase.co/storage/v1/object/public/msgr-avatars/';
const PATH = `avatars/${ME}/crew-a1-1.jpg`;
const FACE = { v: 2, shape: 3, color: 10 };
const PHOTO = `${BASE}${PATH}`;
const ag = (id, o = {}) => ({ id, owner_user_id: ME, slug: id, display_name: id, role_text: '', face: null, hosting: 'local', status: 'active', created_at: '2026-10-01T00:00:00Z', ...o });

function fakeRaw({ rows = [ag('a1', { face: FACE, avatar_path: PATH })], noPhotoCol = false, rpcError = null } = {}) {
  const log = []; const rpcs = [];
  const chain = (entry) => {
    const b = {};
    for (const op of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'maybeSingle']) b[op] = (...args) => { entry.ops.push([op, ...args]); return b; };
    b.then = (res, rej) => {
      const sel = entry.ops.find((o) => o[0] === 'select')?.[1] ?? '';
      const r = noPhotoCol && /avatar_path/.test(sel) ? { data: null, error: { code: '42703', message: 'column msgr2_agents.avatar_path does not exist' } }
        : { data: rows.map((x) => (/avatar_path/.test(sel) ? x : (({ avatar_path, ...y }) => y)(x))), error: null, status: 200 };
      return Promise.resolve(r).then(res, rej);
    };
    return b;
  };
  const storage = { from: (bucket) => ({ getPublicUrl: (path) => ({ data: { publicUrl: `https://p.supabase.co/storage/v1/object/public/${bucket}/${path}` } }) }) };
  return { log, rpcs, storage, auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from(table) { const e = { table, ops: [] }; log.push(e); return chain(e); },
    rpc: async (name, args) => { rpcs.push({ name, args }); return rpcError ? { data: null, error: rpcError } : { data: true, error: null }; } };
}

test('얼굴 저장: msgr_crews update(face) → msgr2_agent_set_profile 1회, 저장한 행 id를 돌려준다(saveAgentLook 그대로)', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const r = await saveAgentLook(c, 'a1', { face: FACE }, new Map());
  assert.equal(r.error, null);
  assert.deepEqual(r.ids, ['a1']);
  assert.deepEqual(raw.rpcs, [{ name: 'msgr2_agent_set_profile', args: { p_agent: 'a1', p_patch: { face: FACE } } }]);
});

test('같은 에이전트의 여러 행(looks ids) — 행마다 1회, 사진 지우기(null)도 그대로 보낸다', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const looks = new Map([['a1', { ids: ['a1', 'a2'], seed: 'a1' }]]);
  const r = await saveAgentLook(c, 'a1', { avatar_url: null }, looks);
  assert.deepEqual(r.ids, ['a1', 'a2']);
  assert.deepEqual(raw.rpcs.map((x) => x.args), [{ p_agent: 'a1', p_patch: { avatar_path: null } }, { p_agent: 'a2', p_patch: { avatar_path: null } }]);
});

test('서버 거절(남의 에이전트·옛 DB에 함수 없음)은 오류로 돌려준다 — 화면이 저장됐다고 말하지 않는다', async () => {
  const raw = fakeRaw({ rpcError: { code: 'PGRST202', message: 'Could not find the function public.msgr2_agent_set_profile' } }); const c = createV2Client(raw);
  const r = await saveAgentLook(c, 'a1', { face: FACE }, new Map());
  assert.ok(r.error); assert.deepEqual(r.ids, []);
});

test('얼굴·사진이 아닌 열, 조건부 채우기(.is)는 종전대로 거절 — 요청 0', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const r1 = await c.from('msgr_crews').update({ display_name: 'x' }).eq('id', 'a1').select('id');
  assert.equal(r1.error?.code, 'v2_unsupported');
  assert.deepEqual(await fillAgentLooks(c, [ag('a1'), ag('a2')]), []);
  assert.equal(raw.rpcs.length, 0);
});

test('목록: avatar_url을 읽어 사진을 보인다, 칸이 없는 옛 DB면 빼고 다시 읽는다(목록이 깨지지 않는다)', async () => {
  const c = createV2Client(fakeRaw());
  const r = await c.from('msgr_crews').select('id, display_name, avatar_url, face').eq('id', 'a1').maybeSingle();
  assert.equal(r.data.avatar_url, PHOTO); assert.deepEqual(r.data.face, FACE);
  const old = fakeRaw({ noPhotoCol: true });
  const r2 = await createV2Client(old).from('msgr_crews').select('id, avatar_url').eq('id', 'a1').maybeSingle();
  assert.equal(r2.error, null); assert.equal(r2.data.id, 'a1'); assert.equal(r2.data.avatar_url, null);
});

test('직무·소개(검수 D1): 프로필 시트의 msgr_crews update({role_text}|{bio}) → 같은 RPC, 봇 직무(msgr_bot_set_role)도 같은 입구', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  assert.equal((await c.from('msgr_crews').update({ role_text: '총괄' }).eq('id', 'a1').select('id')).error, null);
  assert.equal((await c.from('msgr_crews').update({ bio: '회의록을 정리합니다' }).eq('id', 'a1')).error, null);
  assert.equal((await c.rpc('msgr_bot_set_role', { bot_crew: 'b1', new_role_text: '서버 봇' })).error, null);
  assert.deepEqual(raw.rpcs.map((x) => x.args), [
    { p_agent: 'a1', p_patch: { role_text: '총괄' } }, { p_agent: 'a1', p_patch: { bio: '회의록을 정리합니다' } }, { p_agent: 'b1', p_patch: { role_text: '서버 봇' } }]);
  assert.ok(raw.rpcs.every((x) => x.name === 'msgr2_agent_set_profile'));
  const r = await c.from('msgr_crews').select('id, bio').eq('id', 'a1').maybeSingle();
  assert.ok('bio' in r.data, '소개를 읽는다(칸 있는 DB)');
});

test('이름은 메신저에서 바꾸지 않는다 — display_name update는 거절(요청 0)', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  assert.equal((await c.from('msgr_crews').update({ display_name: '새 이름', role_text: 'x' }).eq('id', 'a1')).error?.code, 'v2_unsupported');
  assert.equal(raw.rpcs.length, 0);
});

test('배선: 프로필 시트의 직무·소개 칸은 msgr_crews update / msgr_bot_set_role을 보낸다(어댑터가 v2로 옮긴다)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /supabase\.rpc\('msgr_bot_set_role', \{ bot_crew: crew\.id, new_role_text: v \}\) : await supabase\.from\('msgr_crews'\)\.update\(\{ role_text: v \}\)/);
  assert.match(app, /supabase\.from\('msgr_crews'\)\.update\(\{ bio: v \}\)\.eq\('id', crew\./);
});

test('사진 저장(B1): 자기 프로젝트 공개 주소 → 객체 경로만 보낸다, 다른 호스트·?·#·다른 버킷·..는 요청 없이 거절', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  assert.equal((await c.from('msgr_crews').update({ avatar_url: PHOTO }).eq('id', 'a1').select('id')).error, null);
  assert.deepEqual(raw.rpcs.at(-1).args, { p_agent: 'a1', p_patch: { avatar_path: PATH } });
  const n = raw.rpcs.length;
  for (const bad of [`https://evil.example/storage/v1/object/public/msgr-avatars/${PATH}`, `${PHOTO}?y=1`, `${PHOTO}#/x`, `https://p.supabase.co/storage/v1/object/public/other/${PATH}`,
    `${BASE}avatars/${ME}/../x/a.jpg`, `${BASE}avatars/not-uuid/a.jpg`, 'avatars/' + ME + '/a.jpg', 'javascript:alert(1)']) {
    const r = await c.from('msgr_crews').update({ avatar_url: bad }).eq('id', 'a1');
    assert.equal(r.error?.message, 'msgr2_bad_profile', bad);
  }
  assert.equal(raw.rpcs.length, n, '거절은 요청 0');
});

test('사진 읽기(B1): 경로 → 자기 프로젝트 공개 주소, 모양이 다른 경로는 사진 없음', async () => {
  const r = await createV2Client(fakeRaw()).from('msgr_crews').select('id, avatar_url').eq('id', 'a1').maybeSingle();
  assert.equal(r.data.avatar_url, PHOTO);
  const odd = await createV2Client(fakeRaw({ rows: [ag('a1', { avatar_path: 'https://evil.example/x.png' })] })).from('msgr_crews').select('id, avatar_url').eq('id', 'a1').maybeSingle();
  assert.equal(odd.data.avatar_url, null);
});
