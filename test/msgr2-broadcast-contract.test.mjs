// 서버 방송(realtime.send) ↔ 받는 쪽 핸들러 대조(2026-10-18 — 본체가 v2:w: 방송을 event 이름이 달라 못 받던 결함의 같은 종류를 막는다).
// 서버: supabase/migrations/*msgr2*.sql 의 _msgr2_send_u·_msgr2_send_s·_msgr2_fanout(→ u·s 둘 다)·_msgr2_send_w(event = 봉투 type)·realtime.send 직접 호출.
//       같은 함수를 뒤 파일이 다시 정의하면 마지막 정의만 본다(운영 순서 = 파일 이름 순).
// 받는 쪽: 메신저 앱 apps/messenger/src/link/machine.mjs(v2:u: event '*' → onUserEvent의 USER_EVENTS, 그 밖은 emit('event')로 화면에 넘김,
//         v2:s:는 msg·attach·work만 거름), 본체 src/agent-link-host.mjs(v2:w: event '*' + 봉투 풀기).
// 서버가 새 event를 보내기 시작하면 이 시험이 받는 쪽을 정하라고 실패한다(이름만 맞추는 소스 검사가 아니라 서버 목록 ↔ 받는 목록 대조).
// 모양(payload)은 PG 시험이 잠근다: test/agent-link-w-shape-pg.test.mjs(v2:w:), test/msgr2-realtime-storage-pg.test.mjs·msgr2-presence-attach 계열(v2:u:·v2:s:).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { USER_EVENTS } from '../apps/messenger/src/link/policy.mjs';
import { DIRECTION, TYPES } from '../packages/agent-link/contract/v1.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIG = `${ROOT}supabase/migrations/`;
const files = readdirSync(MIG).filter((f) => /^\d+_msgr2_.*\.sql$/.test(f)).sort();

// 함수 정의를 파일 순서대로 모아 마지막 정의만 남긴다 — 그 본문과 정의 밖(트리거 본문 등) 모두에서 방송 호출을 찾는다
function lastBodies() {
  const fns = new Map();
  for (const f of files) {
    const src = readFileSync(MIG + f, 'utf8').replace(/^\s*--.*$/gm, '');
    const re = /create or replace function public\.([a-z0-9_]+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;
    let m;
    while ((m = re.exec(src))) fns.set(m[1], { file: f, body: m[4] });
  }
  return fns;
}
function serverSends() {
  const out = { u: new Set(), s: new Set(), w: new Set(), other: [] };
  for (const [name, { file, body }] of lastBodies()) {
    for (const m of body.matchAll(/_msgr2_send_u\s*\([^,]+,\s*'([a-z_]+)'/g)) out.u.add(m[1]);
    for (const m of body.matchAll(/_msgr2_send_s\s*\([^,]+,\s*'([a-z_]+)'/g)) out.s.add(m[1]);
    for (const m of body.matchAll(/_msgr2_fanout\s*\([^,]+,\s*'([a-z_]+)'/g)) { out.u.add(m[1]); out.s.add(m[1]); }
    // realtime.send 직접 호출: 토픽 접두로 가른다. _msgr2_send_u/_s/_w 자체의 본문(변수 event)은 위에서 다룬다
    for (const m of body.matchAll(/realtime\.send\s*\(([\s\S]*?)\)\s*;/g)) {
      const args = m[1];
      if (['_msgr2_send_u', '_msgr2_send_s', '_msgr2_send_w'].includes(name)) continue;
      const ev = /,\s*'([a-z_]+)'\s*,\s*'(v2:[a-z]+:|[a-z]+:)'/.exec(args);
      if (!ev) { out.other.push(`${file}:${name}`); continue; }
      const topic = ev[2];
      if (topic === 'v2:u:') out.u.add(ev[1]); else if (topic === 'v2:s:') out.s.add(ev[1]); else out.other.push(`${file}:${name}:${topic}${ev[1]}`);
    }
  }
  // v2:w:는 _msgr2_send_w 하나 — event = 봉투 type(서버가 보내는 type 전부)
  const w = lastBodies().get('_msgr2_send_w');
  assert.ok(w && /coalesce\(p_env->>'type'/.test(w.body) && /'v2:w:'/.test(w.body), '_msgr2_send_w: event = 봉투 type, 토픽 v2:w:');
  for (const t of TYPES) if (DIRECTION[t] === 'server') out.w.add(t);
  return out;
}

// 메신저 앱: onUserEvent가 직접 처리하는 event(USER_EVENTS) + 화면에 넘기는 event(emit('event')) — 화면 소비는 U6(메신저 셸) 몫
const APP_PASSTHROUGH = new Set(['spaces', 'rooms', 'invite']); // machine.mjs:457 emit('event') — 받는 화면 코드는 U6(워커 2)가 붙인다(2026-10-18 총괄에 알림)
const machine = readFileSync(`${ROOT}apps/messenger/src/link/machine.mjs`, 'utf8');
const host = readFileSync(`${ROOT}src/agent-link-host.mjs`, 'utf8');

test('v2:u: — 서버가 보내는 event는 모두 앱이 처리하거나(USER_EVENTS) 화면에 넘기는 목록에 있다', () => {
  const { u } = serverSends();
  assert.ok(u.size >= 5, [...u].join(','));
  assert.match(machine, /ch\.on\('broadcast', \{ event: '\*' \}, \(m\) => \{ if \(ch === uChannel\) onUserEvent\(m\); \}\)/, 'v2:u:는 모든 event를 받는다');
  assert.match(machine, /emit\('event', \{ event: ev, payload \}\);\s*\n\s*\}/, '처리하지 않은 event는 화면에 넘긴다');
  const handled = new Set(Object.values(USER_EVENTS));
  const unknown = [...u].filter((e) => !handled.has(e) && !APP_PASSTHROUGH.has(e));
  assert.deepEqual(unknown, [], '받는 쪽이 정해지지 않은 서버 event — machine.mjs USER_EVENTS나 화면 넘김 목록(이 시험)에 정한다');
  // 화면 넘김 목록에 서버가 더는 보내지 않는 event가 남아 있으면 정리하라고 알린다
  assert.deepEqual([...APP_PASSTHROUGH].filter((e) => !u.has(e)), []);
});

test('v2:s: — 서버가 공간 토픽으로 보내는 event는 앱이 거르는 목록(msg·attach·work) 안에 있다', () => {
  const { s } = serverSends();
  const m = /spaceChans\.includes\(ch\) && \[([^\]]+)\]\.includes/.exec(machine);
  assert.ok(m, 'machine.mjs v2:s: 거르기 목록');
  const allowed = new Set(m[1].split(',').map((x) => x.trim().replace(/^USER_EVENTS\./, '')).map((k) => USER_EVENTS[k] ?? k));
  assert.deepEqual([...s].filter((e) => !allowed.has(e)), [], 'v2:s:로 보내는데 앱이 버리는 event');
});

test('v2:w: — 서버는 봉투 type을 event로 보내고 본체는 모든 event를 받아 봉투를 푼다', () => {
  const { w, other } = serverSends();
  assert.deepEqual([...w].sort(), ['work.approval_decision', 'work.cancel', 'work.offer'].sort());
  assert.match(host, /ch\.on\('broadcast', \{ event: '\*' \}, \(msg\) => \{ const env = unwrapEnvelope\(msg\?\.payload\)/);
  assert.doesNotMatch(host, /ch\.on\('broadcast', \{ event: 'envelope' \}/, '종전 결함 모양(event envelope만 받기)');
  assert.deepEqual(other, [], '토픽을 가르지 못한 realtime.send 직접 호출');
});
