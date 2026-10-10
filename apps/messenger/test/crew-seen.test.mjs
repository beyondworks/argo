// 에이전트 접속 시각 = 기기 단위 심박을 합친 계산 열(유건 2026-10-10, 20261010120000). 열 이름은 last_seen_at 그대로 받는다.
// 잠그는 것: ① 새 서버에서는 크루 목록 한 번의 조회로 계산 열을 받는다(요청 수 그대로) ② 옛 서버(함수 없음)는 '열이 없다' 오류를 보고
// 행 시각으로 다시 읽고 10분 동안 기억한다(실패할 요청을 다시 보내지 않는다) ③ 다른 오류는 옛 서버로 오인하지 않는다
// ④ 실제 loadOrg(App.jsx 원문)가 이 경로를 쓴다 — 행 시각이 오래돼도 기기 심박이 새로우면 접속.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seenCol, withSeenCols, readWithSeen, SEEN_SELECT } from '../src/crew-seen.mjs';
import { createRequestGate } from '../src/rail-state.mjs';
import { stampFetched, seenWithin } from '../src/presence-clock.mjs';
import { crewOrder, withoutCopies } from '../src/mention-candidates.mjs';

const MISSING = 'column msgr_crews.msgr_crew_seen does not exist'; // 옛 서버에서 PostgREST v14.5가 실제로 낸 문구(42703, 10/10 임시 PostgREST로 확인)
beforeEach(() => { seenCol.missingAt = 0; });

test('열 목록의 last_seen_at 하나만 계산 열 별칭으로 바꾼다(face 등 다른 열 그대로)', () => {
  assert.equal(withSeenCols('id, last_seen_at, avatar_url, face'), `id, ${SEEN_SELECT}, avatar_url, face`);
  seenCol.missingAt = Date.now();
  assert.equal(withSeenCols('id, last_seen_at'), 'id, last_seen_at', '옛 서버로 기억하는 동안은 그대로');
  assert.equal(withSeenCols('id, last_seen_at', Date.now() + 600_001), `id, ${SEEN_SELECT}`, '10분 뒤 다시 시도');
});

test('옛 서버: 한 번 실패 → 행 시각으로 다시 읽고 기억, 다음엔 요청 1건 / 다른 오류는 그대로 던진다', async () => {
  const sent = [];
  const old = async (c) => { sent.push(c); if (c.includes('msgr_crew_seen')) throw new Error(MISSING); return [{ id: 'c1', last_seen_at: 'row' }]; };
  assert.deepEqual(await readWithSeen('id, last_seen_at', old), [{ id: 'c1', last_seen_at: 'row' }]);
  assert.deepEqual(sent, [`id, ${SEEN_SELECT}`, 'id, last_seen_at']);
  sent.length = 0; await readWithSeen('id, last_seen_at', old);
  assert.deepEqual(sent, ['id, last_seen_at'], '기억하는 동안 실패할 요청 0');
  seenCol.missingAt = 0;
  await assert.rejects(readWithSeen('id, last_seen_at', async () => { throw new Error('canceling statement due to statement timeout'); }), /timeout/);
  assert.equal(seenCol.missingAt, 0, '다른 오류는 옛 서버 판정을 켜지 않는다');
});

test('실제 loadOrg: 새 서버는 크루 조회 1건으로 기기 심박 시각을 받아 접속, 옛 서버는 행 시각으로 물러난다', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const loadOrg = useCallback(') + 'const loadOrg = useCallback('.length;
  const end = app.indexOf('\n  }, [orgs, uid]);', start) + 4;
  const now = Date.now(); const deviceAt = new Date(now - 5_000).toISOString(); const rowAt = new Date(now - 3_600_000).toISOString(); // 행은 1시간 전(옛 호환 쓰기를 끈 뒤 모양), 기기 심박은 5초 전
  let serverHasSeen = true; const crewSelects = []; const state = {};
  const supabase = { from(table) { let cols = '';
    return { select(c) { cols = c; if (table === 'msgr_crews') crewSelects.push(c); return this; }, eq() { return this; }, is() { return this; }, order() { return this; }, in() { return this; }, maybeSingle() { return this; },
      then(res, rej) {
        if (table === 'msgr_crews' && cols.includes('msgr_crew_seen') && !serverHasSeen) return Promise.reject(new Error(MISSING)).then(res, rej);
        if (table === 'msgr_crews') return Promise.resolve([{ id: 'c1', owner_user_id: 'other', display_name: 'c', slug: 'c', status: 'active', face: null, last_seen_at: cols.includes('msgr_crew_seen') ? deviceAt : rowAt }]).then(res, rej);
        if (table === 'msgr_channels') return Promise.resolve([{ id: 'ch', kind: 'public' }]).then(res, rej);
        if (table === 'msgr_org_members' || table === 'msgr_channel_members') return Promise.resolve([]).then(res, rej);
        return Promise.resolve({ data: null }).then(res, rej); } }; } };
  const setters = Object.fromEntries(['Channels', 'PreviewChannels', 'Members', 'Crews', 'MyAvailable', 'Ent', 'Policy', 'DmMembers'].map((k) => [`set${k}`, (v) => { state[k] = v; }]));
  const activeOrg = { current: 'A' };
  const deps = { stampFetched, crewOrder, withoutCopies, readWithSeen, joinedRef: { current: new Set() }, supabase, q: async (x) => await x, uid: 'me', activeOrg, loadedOrg: { current: null }, orgRequests: { current: createRequestGate(() => activeOrg.current) }, orgs: [{ id: 'A' }], crewTier: () => '', readLastCh: () => null, faceCol: { missingAt: 0 }, ...setters, setChId: () => {} };
  const loadOrg = new Function(...Object.keys(deps), `return (${app.slice(start, end)});`)(...Object.values(deps));

  await loadOrg('A');
  assert.equal(crewSelects.length, 1, '새 서버: 크루 조회 1건(요청 수 그대로)');
  assert.match(crewSelects[0], /last_seen_at:msgr_crew_seen/);
  assert.equal(state.Crews[0].last_seen_at, deviceAt);
  assert.equal(seenWithin(state.Crews[0], 90_000), true, '행이 오래돼도 기기 심박이 새로우면 접속');

  serverHasSeen = false; crewSelects.length = 0; await loadOrg('A');
  assert.equal(crewSelects.length, 2, '옛 서버: 계산 열 실패 → 행 시각으로 한 번 더');
  assert.equal(state.Crews[0].last_seen_at, rowAt);
  crewSelects.length = 0; await loadOrg('A');
  assert.equal(crewSelects.length, 1, '기억하는 동안은 바로 행 시각(실패할 요청 0)');
  assert.doesNotMatch(crewSelects[0], /msgr_crew_seen/);
});
