// v2 에이전트 얼굴·사진 저장(0.1.65 결함 3, 2026-10-25 유건 아이폰 — "얼굴 저장"을 눌러도 아바타가 그대로).
// 원인: 화면은 옛 msgr_crews를 update하는데 v2 조회 어댑터(CrewBuilder)가 모든 쓰기를 v2_unsupported로 막았다. 사진 칸도 읽지 않았다(avatar_url: null 고정).
// 지금: 얼굴·사진 update는 에이전트마다 msgr2_agent_set_look(DB 20261025130000) 1회, 목록은 avatar_url을 읽는다(칸이 없는 옛 DB면 빼고 다시 읽는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Client } from '../src/v2/source.mjs';
import { saveAgentLook, fillAgentLooks } from '../src/agent-groups.mjs';

const ME = 'u-me';
const FACE = { v: 2, shape: 3, color: 10 };
const PHOTO = `https://p.supabase.co/storage/v1/object/public/msgr-avatars/avatars/${ME}/crew-a1-1.jpg`;
const ag = (id, o = {}) => ({ id, owner_user_id: ME, slug: id, display_name: id, role_text: '', face: null, hosting: 'local', status: 'active', created_at: '2026-10-01T00:00:00Z', ...o });

function fakeRaw({ rows = [ag('a1', { face: FACE, avatar_url: PHOTO })], noPhotoCol = false, rpcError = null } = {}) {
  const log = []; const rpcs = [];
  const chain = (entry) => {
    const b = {};
    for (const op of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'maybeSingle']) b[op] = (...args) => { entry.ops.push([op, ...args]); return b; };
    b.then = (res, rej) => {
      const sel = entry.ops.find((o) => o[0] === 'select')?.[1] ?? '';
      const r = noPhotoCol && /avatar_url/.test(sel) ? { data: null, error: { code: '42703', message: 'column msgr2_agents.avatar_url does not exist' } }
        : { data: rows.map((x) => (/avatar_url/.test(sel) ? x : (({ avatar_url, ...y }) => y)(x))), error: null, status: 200 };
      return Promise.resolve(r).then(res, rej);
    };
    return b;
  };
  return { log, rpcs, auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) },
    from(table) { const e = { table, ops: [] }; log.push(e); return chain(e); },
    rpc: async (name, args) => { rpcs.push({ name, args }); return rpcError ? { data: null, error: rpcError } : { data: true, error: null }; } };
}

test('얼굴 저장: msgr_crews update(face) → msgr2_agent_set_look 1회, 저장한 행 id를 돌려준다(saveAgentLook 그대로)', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const r = await saveAgentLook(c, 'a1', { face: FACE }, new Map());
  assert.equal(r.error, null);
  assert.deepEqual(r.ids, ['a1']);
  assert.deepEqual(raw.rpcs, [{ name: 'msgr2_agent_set_look', args: { p_agent: 'a1', p_patch: { face: FACE } } }]);
});

test('같은 에이전트의 여러 행(looks ids) — 행마다 1회, 사진 지우기(null)도 그대로 보낸다', async () => {
  const raw = fakeRaw(); const c = createV2Client(raw);
  const looks = new Map([['a1', { ids: ['a1', 'a2'], seed: 'a1' }]]);
  const r = await saveAgentLook(c, 'a1', { avatar_url: null }, looks);
  assert.deepEqual(r.ids, ['a1', 'a2']);
  assert.deepEqual(raw.rpcs.map((x) => x.args), [{ p_agent: 'a1', p_patch: { avatar_url: null } }, { p_agent: 'a2', p_patch: { avatar_url: null } }]);
});

test('서버 거절(남의 에이전트·옛 DB에 함수 없음)은 오류로 돌려준다 — 화면이 저장됐다고 말하지 않는다', async () => {
  const raw = fakeRaw({ rpcError: { code: 'PGRST202', message: 'Could not find the function public.msgr2_agent_set_look' } }); const c = createV2Client(raw);
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
