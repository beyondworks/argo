// 옛 메신저 사용 중지(supabase/migrations/…_argo_old_msgr_cutoff.sql)의 전제: v2 판(0.1.64+)은 옛 판 지문 RPC를 서버로 보내지 않는다.
// 지문 = 웹 클라이언트의 POST rpc/msgr_presence_ping·rpc/msgr_push_badge_resync. v2 앱이 이 둘을 보내면 지금 판 사용자가 로그아웃된다 — 그 길을 여기서 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createV2Client, v2Route } from '../src/v2/source.mjs';

const FINGERPRINT = ['msgr_presence_ping', 'msgr_push_badge_resync'];
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('v2 어댑터는 지문 RPC를 원래 클라이언트로 보내지 않는다(요청 0) — 심박은 빈 값, 배지 재동기화는 v2_unsupported', async () => {
  const sent = [];
  const raw = { rpc: async (name) => { sent.push(name); return { data: null, error: null }; }, from: () => { throw new Error('표 조회 없음'); } };
  const client = createV2Client(raw);
  const ping = await client.rpc('msgr_presence_ping', { source: 'desktop' });
  const badge = await client.rpc('msgr_push_badge_resync');
  assert.deepEqual(sent, [], '서버로 간 RPC 0');
  assert.equal(ping.error, null);
  assert.equal(badge.error?.code ?? badge.error?.message, 'v2_unsupported');
  assert.equal(v2Route('rpc', 'msgr_presence_ping'), 'none');
  assert.equal(v2Route('rpc', 'msgr_push_badge_resync'), 'unsupported');
  // 대조: keep RPC는 실제로 보낸다(측정이 살아 있음)
  await client.rpc('msgr_people_names', {});
  assert.deepEqual(sent, ['msgr_people_names']);
});

test('셸은 심박·배지를 어댑터(supabase = v2 클라이언트)로만 부른다 — 원래 클라이언트로 부르는 코드가 없다', () => {
  const app = read('../src/App.jsx');
  assert.match(app, /const supabase = V2 \? createV2ClientFor\(rawSupabase\) : rawSupabase;/, 'v2 빌드는 셸 클라이언트가 어댑터');
  assert.match(app, /return startPresence\(\{ supabase, source:/, '심박은 셸 클라이언트(어댑터)로');
  assert.match(app, /supabase\.rpc\('msgr_push_badge_resync'\)/, '배지 재동기화는 셸 클라이언트(어댑터)로');
  const src = new URL('../src/', import.meta.url);
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir); if (e.isDirectory()) walk(p); else if (/\.(m?js|jsx)$/.test(e.name)) files.push(p); } };
  walk(src);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const name of FINGERPRINT) assert.doesNotMatch(s, new RegExp(`raw(Supabase)?\\.rpc\\(\\s*'${name}'`), `${f.pathname}: ${name}를 원래 클라이언트로 부르지 않는다`);
  }
  assert.match(read('../src/presence.mjs'), /supabase\.rpc\('msgr_presence_ping'/, '심박은 넘겨받은 클라이언트로');
});

test('서버 지문과 이 목록이 같다 — 마이그레이션의 경로 목록이 바뀌면 이 시험도 함께 바꾼다', () => {
  const dir = new URL('../../../supabase/migrations/', import.meta.url);
  const f = readdirSync(dir).filter((n) => n.endsWith('_argo_old_msgr_cutoff.sql'));
  assert.equal(f.length, 1);
  const sql = readFileSync(new URL(f[0], dir), 'utf8');
  const m = sql.match(/in \('rpc\/([a-z0-9_]+)', 'rpc\/([a-z0-9_]+)'\)/);
  assert.ok(m, '경로 목록');
  assert.deepEqual([m[1], m[2]].sort(), [...FINGERPRINT].sort());
  assert.match(sql, /position\('runtime=web' in xci\) > 0/, '웹 클라이언트만');
});
