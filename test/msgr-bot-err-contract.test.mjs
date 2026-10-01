// 봇 RPC가 raise하는 오류 이름은 모두 엣지 ERR 표(supabase/functions/msgr-bot/core.js)에 있어야 한다(반대 검토 personal-bots H1, 2026-10-01).
// 엣지가 모르는 이름은 500이 되고, Hermes·OpenClaw는 5xx 답을 outbox에서 계속 재시도하느라 getUpdates를 부르지 않는다 —
// 개인 쪽 거절 하나가 그 봇의 조직 배달까지 멈춘다. 마이그레이션이 엣지 배포보다 먼저 들어가도 봇이 멈추지 않게 이름을 잠근다.
// 범위: core.js가 rpc()로 부르는 함수의 가장 늦은 정의 + 그 정의가 부르는 내부 함수(전이) + 봇 글 삽입 때 도는 msgr_messages BEFORE INSERT 트리거 함수.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const core = readFileSync(root('supabase/functions/msgr-bot/core.js'), 'utf8');
const errStart = core.indexOf('const ERR = {');
const ERR = new Set([...core.slice(errStart, core.indexOf('\n};', errStart)).matchAll(/^\s*(msgr_[a-z_]+):/gm)].map((m) => m[1]));
const dir = root('supabase/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ f, s: readFileSync(`${dir}/${f}`, 'utf8') }));
const DEF = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi;

// 함수 이름 → 가장 늦은 파일의 정의 본문(같은 파일의 겹정의는 모두)
const latest = new Map();
for (const { f, s } of files) {
  const defs = [...s.matchAll(DEF)];
  const byName = new Map();
  defs.forEach((m, i) => {
    const body = s.slice(m.index, i + 1 < defs.length ? defs[i + 1].index : s.length);
    const name = m[1].toLowerCase();
    byName.set(name, (byName.get(name) ?? '') + body);
  });
  for (const [name, body] of byName) latest.set(name, { f, body });
}

// core.js가 부르는 RPC — rpc('이름', …)과 삼항으로 고르는 이름(getUpdates·ack/expire)까지 봇 함수 문자열 리터럴을 모두 줍는다
const rpcs = [...new Set([...core.matchAll(/'(msgr_bot_[a-z_]+)'/g)].map((m) => m[1]).filter((n) => latest.has(n)))];
const TRIGGERS = ['msgr_message_fill', 'msgr_dm_message_guard', 'msgr_crew_reply_gate', 'msgr_messages_crew_scope_guard', 'msgr_message_entitlement_gate', 'msgr_work_message_guard', 'msgr_messages_server_time'];

// 봇 경로에서 닿지 않는 이름(이유를 적는다). 늘리지 말고 ERR에 넣거나 기존 이름을 쓴다.
const UNREACHABLE = new Set([
  'msgr_channel_missing', // msgr_message_fill: 없는 채널에 글 삽입 — 봇 RPC는 삽입 전에 채널을 찾아 msgr_bot_no_channel·msgr_not_allowed로 먼저 거른다
]);

function reach(start) {
  const seen = new Set(); const stack = [...start];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n) || !latest.has(n)) continue;
    seen.add(n);
    for (const m of latest.get(n).body.matchAll(/\b(_?msgr_[a-z0-9_]+)\s*\(/g)) if (m[1] !== n) stack.push(m[1]);
  }
  return seen;
}

test('엣지 ERR 표와 봇 RPC 목록을 읽었다(비면 아래 테스트가 아무것도 잠그지 않는다)', () => {
  assert.ok(ERR.size >= 30, `ERR ${ERR.size}개`);
  assert.ok(ERR.has('msgr_not_allowed') && ERR.has('msgr_bot_not_member'));
  for (const fn of ['msgr_bot_updates', 'msgr_bot_send', 'msgr_bot_finish', 'msgr_bot_typing', 'msgr_bot_updates_with_delivery', 'msgr_bot_request_approval']) assert.ok(rpcs.includes(fn), `core.js가 부르는 RPC에 ${fn}`);
  for (const t of TRIGGERS) assert.ok(latest.has(t), `트리거 함수 ${t} 정의를 찾는다`);
});

test('봇 RPC(전이 포함)와 봇 글 삽입 트리거가 raise하는 이름은 모두 엣지 ERR에 있다', () => {
  const fns = reach([...rpcs, ...TRIGGERS]);
  assert.ok(fns.has('_msgr_bot_twin') && fns.has('_msgr_bot_personal_updates'), '개인 공간 봇 경로(20261001140000)가 범위에 든다');
  const missing = [];
  for (const fn of fns) {
    for (const m of latest.get(fn).body.matchAll(/raise\s+exception\s+'(msgr_[a-z_]+)'/gi)) if (!ERR.has(m[1]) && !UNREACHABLE.has(m[1])) missing.push(`${m[1]} ← ${fn} (${latest.get(fn).f})`);
  }
  assert.deepEqual([...new Set(missing)].sort(), [], 'ERR에 없는 이름은 엣지에서 500 → 봇 outbox 정지');
});
