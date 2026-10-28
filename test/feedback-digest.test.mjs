// 피드백 쪽지 운영 알림(scripts/feedback-digest.mjs) 행동 시험 — 가짜 Supabase(test/helpers/fake-supabase-http.mjs)에
// 실제 HTTP로 붙여 돌린다. 잠그는 것: 새 행 없음 → 요청 1회·파일 쓰기 0, 새 행 2개 → 요약 2건·커서 이동·다음 실행은
// 커서 이후만, 이메일 미노출, 토큰 가림, 커서 파일 손상 시 옮겨 두고 되돌아보기 창부터(놓치지 않음), 조회 실패 시 커서 유지.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { runDigest, redactSecrets } from '../scripts/feedback-digest.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/feedback-digest.mjs', import.meta.url));
const KEY = 'test-service-role-key-not-real';
const U1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const U2 = '22222222-aaaa-4bbb-8ccc-000000000002';
const dirs = [];
const servers = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fbdigest-')); dirs.push(d); return d; };
// 단언이 실패해도 가짜 서버가 남아 시험이 멈추지 않게 끝에서 모두 닫는다(close는 두 번 불러도 된다)
after(async () => {
  for (const s of servers) await s.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const row = (n, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  user_id: n % 2 ? U1 : U2,
  email: `paying.user${n}@example.com`,
  message: `쪽지 ${n}`,
  meta: { ua: 'Argo/0.1.119', ref: `abcd000${n}` },
  created_at: `2026-10-27T12:2${n}:00.123456+00:00`,
  ...extra,
});

/** 가짜 서버의 장애 주입 훅으로 feedback·entitlements를 답한다. 키셋 커서(or=…)를 실제로 해석해 걸러 준다. */
async function fake(rows, { ents = [], fail = null } = {}) {
  const sb = await startFakeSupabase();
  servers.push(sb);
  const seen = [];
  sb.fault = (req, path) => {
    const q = new URL(req.url, 'http://x').searchParams;
    if (path === '/rest/v1/feedback') {
      seen.push(Object.fromEntries(q));
      if (fail) return fail;
      const sel = q.get('select').split(',');
      let list = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const or = q.get('or');
      if (or) {
        const m = or.match(/^\(created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\.([0-9a-f-]+)\)\)$/);
        assert.ok(m, `커서 필터 모양: ${or}`);
        list = list.filter((r) => r.created_at > m[1] || (r.created_at === m[2] && r.id > m[3]));
      }
      // created_at 조건은 여러 번 올 수 있다(PostgREST는 AND) — gt.·lte.만 쓴다
      for (const c of q.getAll('created_at')) {
        const [, op, v] = c.match(/^(gt|lte)\.(.+)$/) ?? assert.fail(`created_at 조건 모양: ${c}`);
        list = list.filter((r) => (op === 'gt' ? new Date(r.created_at) > new Date(v) : new Date(r.created_at) <= new Date(v)));
      }
      list = list.slice(0, Number(q.get('limit')));
      // PostgREST처럼 select한 칸만 돌려준다 — 이메일을 고르면 이메일이 실려 온다
      return { status: 200, body: list.map((r) => Object.fromEntries(sel.map((c) => [c, r[c]]))) };
    }
    if (path === '/rest/v1/entitlements') return { status: 200, body: ents };
    return null;
  };
  return { sb, seen, feedHits: () => sb.hits.filter((h) => h.k === 'GET /rest/v1/feedback').length, restHits: () => sb.hits.filter((h) => h.k.includes('/rest/v1/')) };
}

const NOW = Date.parse('2026-10-28T10:00:00Z');
const capture = () => { const o = { out: '', err: '' }; o.write = (s) => { o.out += s; }; o.warn = (s) => { o.err += s; }; return o; };

test('새 행 없음 → feedback 조회 1회, 상태·출력 파일 쓰기 0', async () => {
  const { sb, feedHits, restHits } = await fake([]);
  const d = tmp(); const statePath = join(d, 'state.json'); const out = join(d, 'out.log');
  const c = capture();
  const r = await runDigest({ url: sb.url, key: KEY, statePath, out, now: NOW, write: c.write, warn: c.warn });
  await sb.close();
  assert.equal(r.status, 0); assert.equal(r.count, 0);
  assert.equal(feedHits(), 1); assert.equal(restHits().length, 1, '새 행이 없으면 요금제 조회도 하지 않는다');
  assert.equal(existsSync(statePath), false, '유휴 실행은 커서 파일을 만들지 않는다');
  assert.equal(existsSync(out), false); assert.equal(c.out, ''); assert.equal(readdirSync(d).length, 0);
});

test('새 행 2개 → 요약 2건, 커서가 마지막 행으로, 다음 실행은 커서 이후만(겹침·누락 없음)', async () => {
  const rows = [row(1), row(2)];
  const { sb, seen } = await fake(rows, { ents: [{ user_id: U1, plan: 'pro', ends_at: null, granted: false }] });
  const d = tmp(); const statePath = join(d, 'state.json');
  const c = capture();
  const r = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c.write, warn: c.warn });
  assert.equal(r.status, 0); assert.equal(r.count, 2);
  assert.equal((c.out.match(/\[Argo 피드백\]/g) ?? []).length, 2);
  assert.match(c.out, /2026-10-27\(화\) 21:21 KST · ref abcd0001 · 사용자 11111111 · 요금제 pro\n위치: feedback 표 id=00000000-0000-4000-8000-000000000001\n내용: 쪽지 1/);
  assert.match(c.out, /ref abcd0002 · 사용자 22222222\n/, 'entitlements 행이 없는 사용자는 요금제를 생략한다');
  assert.equal(seen[0].order, 'created_at.asc,id.asc'); assert.ok(Number(seen[0].limit) > 0);
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.id, rows[1].id); assert.equal(st.created_at, rows[1].created_at);

  // 같은 시각에 id가 더 큰 행 + 더 늦은 행이 새로 들어옴 → 그 둘만
  rows.push(row(3, { created_at: rows[1].created_at, id: '00000000-0000-4000-8000-000000000009' }), row(4));
  const c2 = capture();
  const r2 = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c2.write, warn: c2.warn });
  assert.equal(r2.count, 2);
  assert.doesNotMatch(c2.out, /abcd0001|abcd0002/); assert.match(c2.out, /abcd0003/); assert.match(c2.out, /abcd0004/);
  // 세 번째: 더 없음 → 커서 파일 그대로
  const before = readFileSync(statePath, 'utf8');
  const r3 = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: () => {}, warn: () => {} });
  assert.equal(r3.count, 0); assert.equal(readFileSync(statePath, 'utf8'), before);
  await sb.close();
});

test('이메일은 요약·출력 파일에 나오지 않고 select에도 없다', async () => {
  const { sb, seen } = await fake([row(1), row(2, { message: '연락은 other.person@corp.co.kr 로' })]);
  const d = tmp(); const out = join(d, 'out.log');
  const r = await runDigest({ url: sb.url, key: KEY, statePath: join(d, 's.json'), out, now: NOW, warn: () => {} });
  await sb.close();
  assert.equal(r.count, 2);
  const text = readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /@/); assert.doesNotMatch(text, /paying\.user/);
  assert.match(text, /\[가림:이메일\]/);
  assert.doesNotMatch(seen[0].select, /email/);
});

test('메시지 속 토큰·키·접속 문자열은 가린다(500자 자르기 전에)', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXBhcnQ';
  const msg = [
    `토큰 ${jwt}`, 'anthropic sk-ant-api03-ABCDEFGHIJKLMNOP', 'openai sk-proj-1234567890abcdef',
    'Authorization: Bearer abc.def.ghi', 'resend re_AbCdEf123456', 'split sk-\u0007SPLITSPLIT9999','gh ghp_AAAABBBBCCCCDDDD',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----','db postgresql://postgres:pw@db.example.supabase.co:5432/postgres',
    'x'.repeat(520) + ' eyJtYWlsYm94IjoxfQ.tail',
  ].join('\n');
  const { sb } = await fake([row(1, { message: msg })]);
  const c = capture();
  await runDigest({ url: sb.url, key: KEY, statePath: join(tmp(), 's.json'), now: NOW, write: c.write, warn: c.warn });
  await sb.close();
  for (const leak of [jwt, 'sk-ant-api03', 'sk-proj-1234', 'abc.def.ghi', 'postgresql://', 'postgres:pw', 'eyJ', 're_AbCdEf', 'ghp_AAAA', 'MIIEvQIBADANBgkq', 'SPLITSPLIT']) assert.ok(!c.out.includes(leak), `새어 나감: ${leak}`);
  assert.match(c.out, /\[가림:JWT\]/); assert.match(c.out, /Bearer \[가림\]/); assert.match(c.out, /\[가림:접속문자열\]/);
  assert.match(c.out, /자 중 500자\)/);
  assert.ok(!c.out.includes(KEY) && !c.err.includes(KEY), '서비스 키는 어디에도 출력하지 않는다');
  assert.equal(redactSecrets('평범한 문장 sk 이야기'), '평범한 문장 sk 이야기');
});

test('커서 파일 손상 → 지우지 않고 옆으로 옮긴 뒤 되돌아보기 창부터 다시(놓치지 않음), 새 커서 저장', async () => {
  const { sb, seen } = await fake([row(1), row(2)]);
  const d = tmp(); const statePath = join(d, 'state.json');
  writeFileSync(statePath, '{"created_at": "2026-10-27T00:00:00Z", "id": "x\') or 1=1"');
  const c = capture();
  const r = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c.write, warn: c.warn });
  assert.equal(r.status, 0); assert.equal(r.count, 2, '손상 뒤에도 되돌아보기 창 안의 쪽지는 낸다');
  assert.match(c.err, /커서 파일 손상/);
  assert.equal(seen[0].or, undefined, '손상된 값을 조회 필터에 넣지 않는다');
  const aside = readdirSync(d).find((n) => n.startsWith('state.json.corrupt-'));
  assert.ok(aside, '손상 파일은 원인 확인용으로 남긴다');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).id, row(2).id);
  // 잘못된 모양(필드 위조)도 손상으로 본다
  writeFileSync(statePath, JSON.stringify({ created_at: '2026-10-27T00:00:00Z",id.gt.0', id: row(1).id }));
  const c2 = capture();
  await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c2.write, warn: c2.warn });
  assert.match(c2.err, /커서 파일 손상/);
  await sb.close();
});

test('미래로 위조한 created_at(2999년) 행이 커서를 미래로 끌고 가지 않는다 — 이후 쪽지도 계속 나온다', async () => {
  const soon = new Date(NOW + 2 * 60_000).toISOString(); // 시계 차이 범위(지금~+5분)
  const rows = [row(1), row(5, { created_at: '2999-01-01T00:00:00+00:00', id: '00000000-0000-4000-8000-0000000000ff' }), row(6, { created_at: soon })];
  const { sb, seen } = await fake(rows);
  const d = tmp(); const statePath = join(d, 'state.json');
  const c = capture();
  const r = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c.write, warn: c.warn });
  assert.equal(r.status, 0);
  assert.match(seen[0].created_at, /^lte\./, '조회에 created_at 상한(지금+5분)이 붙는다');
  assert.doesNotMatch(c.out, /abcd0005/, '2999년 행은 상한에 걸려 고르지 않는다');
  assert.match(c.out, /ref abcd0001/);
  assert.match(c.out, /⚠ 지금보다 뒤 시각[^\n]*ref abcd0006/, '시계 차이 범위의 행은 내되 경고를 붙인다');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.id, row(1).id, '커서는 지금 이하 시각의 마지막 행까지만');
  assert.ok(Date.parse(st.created_at) <= NOW);

  // 그 뒤 들어온 정상 쪽지는 다음 실행에 나온다
  rows.push(row(7, { created_at: new Date(NOW + 10 * 60_000).toISOString() }));
  const c2 = capture();
  await runDigest({ url: sb.url, key: KEY, statePath, now: NOW + 15 * 60_000, write: c2.write, warn: c2.warn });
  assert.match(c2.out, /ref abcd0007/); assert.doesNotMatch(c2.out, /abcd0005/);
  assert.ok(Date.parse(JSON.parse(readFileSync(statePath, 'utf8')).created_at) <= NOW + 15 * 60_000);

  // 고치기 전 판이 미래 시각을 커서로 저장해 둔 경우 — 손상으로 보고 되돌아보기 창부터 다시
  writeFileSync(statePath, JSON.stringify({ created_at: '2999-01-01T00:00:00+00:00', id: rows[1].id }));
  const c3 = capture();
  const r3 = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW + 15 * 60_000, write: c3.write, warn: c3.warn });
  assert.equal(r3.status, 0); assert.match(c3.err, /커서 파일 손상/); assert.match(c3.out, /ref abcd0007/);
});

test('조회 실패 → 종료 1, 커서·출력 그대로(다음 주기에 다시 본다)', async () => {
  const { sb } = await fake([row(1)], { fail: { status: 500, body: { code: 'XX000', message: 'boom' } } });
  const d = tmp(); const statePath = join(d, 'state.json');
  writeFileSync(statePath, JSON.stringify({ created_at: '2026-10-27T00:00:00+00:00', id: row(1).id }));
  const before = readFileSync(statePath, 'utf8');
  const c = capture();
  const r = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: c.write, warn: c.warn });
  await sb.close();
  assert.equal(r.status, 1); assert.equal(c.out, ''); assert.equal(readFileSync(statePath, 'utf8'), before);
  assert.match(c.err, /HTTP 500 XX000/);
});

test('출력(파이프 쓰기)이 늦게 실패하면 커서를 옮기지 않는다 / 커서 저장 실패는 종료 1로 알린다', async () => {
  const { sb } = await fake([row(1)]);
  const d = tmp(); const statePath = join(d, 'state.json');
  const c = capture();
  const late = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })), 20));
  const r = await runDigest({ url: sb.url, key: KEY, statePath, now: NOW, write: late, warn: c.warn });
  assert.equal(r.status, 1); assert.equal(existsSync(statePath), false, '다 못 낸 요약의 커서는 저장하지 않는다');
  assert.match(c.err, /요약 출력 실패\(EPIPE\)/);
  // 상태 폴더 자리에 파일이 있어 저장 불가
  const blocker = join(d, 'blocked'); writeFileSync(blocker, 'x');
  const c2 = capture();
  const r2 = await runDigest({ url: sb.url, key: KEY, statePath: join(blocker, 's.json'), now: NOW, write: c2.write, warn: c2.warn });
  assert.equal(r2.status, 1); assert.match(c2.err, /커서 저장 실패/); assert.match(c2.out, /ref abcd0001/);
});

test('CLI: 환경변수 이름으로만 설정, 키 없으면 종료 2 / 있으면 가짜 서버에 서비스 키로 요청', async () => {
  const d = tmp();
  const env0 = { PATH: process.env.PATH, HOME: d };
  const miss = spawnSync(process.execPath, [SCRIPT, '--state', join(d, 's.json')], { env: env0, encoding: 'utf8' });
  assert.equal(miss.status, 2); assert.match(miss.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--notion'], { env: env0, encoding: 'utf8' });
  assert.equal(bad.status, 2);

  const { sb } = await fake([row(1)]);
  const env = { ...env0, NEXT_PUBLIC_SUPABASE_URL: sb.url, SUPABASE_SERVICE_ROLE_KEY: KEY };
  const p = await new Promise((res) => {
    import('node:child_process').then(({ execFile }) => execFile(process.execPath, [SCRIPT, '--state', join(d, 's.json'), '--since', '2026-10-20T00:00:00Z'], { env, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr })));
  });
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /ref abcd0001/); assert.ok(!p.stdout.includes(KEY) && !p.stderr.includes(KEY));
  assert.ok(sb.hits.filter((h) => h.k === 'GET /rest/v1/feedback').every((h) => h.auth === `Bearer ${KEY}`));
  await sb.close();
});
