// 크루 우편함 — 적재·배달·유계 재시도·상한의 행위 테스트(실 fs, 임시 ARGO_ROOT).
// 배선(스케줄러·도구 등록)은 소스 스캔으로 잠근다("부품만 잠그고 배선 무방비" 교훈).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let WS; let mod; let paths;

before(async () => {
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-crewmail-'));
  ({ paths } = await import('../src/workspace.mjs'));
  mod = await import('../src/crewmail.mjs');
  WS = 'lean-test-mail';
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(paths(WS).root, { recursive: true });
  await writeFile(paths(WS).company, JSON.stringify({ id: WS, name: '테스트' }));
});
after(async () => { await rm(process.env.ARGO_ROOT, { recursive: true, force: true }).catch(() => {}); });

const mailFiles = async (slug) => {
  try { return (await readdir(join(paths(WS).root, 'mail', slug))).sort(); } catch { return []; }
};

test('적재 — to·cc 각각 사본, 중복·자기참조 cc 제거', async () => {
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'b', cc: ['c', 'b', 'a', 'c'], message: '보고 부탁' });
  assert.deepEqual(await mailFiles('b'), [`${id}-to.json`]);
  assert.deepEqual(await mailFiles('c'), [`${id}-cc.json`]);
  assert.deepEqual(await mailFiles('a'), []); // 자기 참조 제거
  const msg = JSON.parse(await readFile(join(paths(WS).root, 'mail', 'b', `${id}-to.json`), 'utf8'));
  assert.equal(msg.kind, 'to'); assert.equal(msg.fromName, '알파'); assert.equal(msg.attempts, 0);
});

test('배달 성공 — runTurn 호출 후 파일 제거, cc 프레임 구분', async () => {
  const calls = [];
  const n = await mod.deliverCrewMail(WS, async (slug, msg) => { calls.push({ slug, kind: msg.kind }); });
  assert.equal(n, 2);
  assert.deepEqual(await mailFiles('b'), []);
  assert.deepEqual(await mailFiles('c'), []);
  const kinds = Object.fromEntries(calls.map((c) => [c.slug, c.kind]));
  assert.equal(kinds.b, 'to'); assert.equal(kinds.c, 'cc');
});

test('mailPrompt — to는 회신 안내, cc는 회신 의무 없음 표기', () => {
  const to = mod.mailPrompt({ kind: 'to', fromName: '알파', message: 'x' });
  const cc = mod.mailPrompt({ kind: 'cc', fromName: '알파', message: 'x' });
  assert.match(to, /send_to_crew/); assert.match(to, /답장/);
  assert.match(cc, /참조/); assert.doesNotMatch(cc, /send_to_crew/);
});

test('유계 재시도 — 실패는 attempts 증가, 소진 시 dead/로 이동(조용한 소실 금지)', async () => {
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'b', message: '실패 유도' });
  for (let i = 0; i < mod.MAIL_MAX_ATTEMPTS; i++) {
    await mod.deliverCrewMail(WS, async () => { throw new Error('runner down'); });
  }
  assert.deepEqual(await mailFiles('b'), [], '소진된 메시지가 우편함에 남아 무한 재시도된다');
  const dead = await readdir(join(paths(WS).root, 'mail', 'dead'));
  assert.ok(dead.some((f) => f.includes(id)), 'dead/에 없다 — 무증상 소실');
  const rec = JSON.parse(await readFile(join(paths(WS).root, 'mail', 'dead', dead.find((f) => f.includes(id))), 'utf8'));
  assert.equal(rec.attempts, mod.MAIL_MAX_ATTEMPTS);
  assert.match(rec.lastError, /runner down/);
});

test('틱 상한 — MAIL_PER_TICK 초과분은 다음 틱으로', async () => {
  const ids = [];
  for (let i = 0; i < mod.MAIL_PER_TICK + 2; i++) {
    ids.push(await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'd', message: `${i}` }));
    await new Promise((r) => setTimeout(r, 2)); // id 시각 접두 충돌 방지
  }
  const n1 = await mod.deliverCrewMail(WS, async () => {});
  assert.equal(n1, mod.MAIL_PER_TICK);
  assert.equal((await mailFiles('d')).length, 2);
  const n2 = await mod.deliverCrewMail(WS, async () => {});
  assert.equal(n2, 2);
});

test('hop·chain 전파 — 비동기 경로에도 연쇄 상한 재료가 실린다', async () => {
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'e', message: 'x', hop: 2, chain: ['boss', 'a'] });
  let got = null;
  await mod.deliverCrewMail(WS, async (slug, msg, opts) => { got = opts; });
  assert.equal(got.hop, 2);
  assert.deepEqual(got.chain, ['boss', 'a']);
  void id;
});

// ── 배선 소스 스캔 ──
const read = (p) => readFileSync(join(root, p), 'utf8');

test('배선 — 스케줄러가 deliverCrewMail을 부르고 스레드에 남긴다', () => {
  const s = read('src/scheduler.mjs');
  assert.match(s, /deliverCrewMail\(c\.id/, '스케줄러 배달 배선이 없다 — 쪽지가 영영 배달되지 않는다');
  assert.match(s, /appendTurn\(c\.id, slug/, '수신 턴이 스레드에 안 남는다 — 사장이 대화를 못 본다');
});

test('배선 — send_to_crew 도구가 delegate와 같은 게이트(colleagues)로 등록된다', () => {
  const s = read('src/chat.mjs');
  assert.match(s, /\.\.\.\(colleagues\.length \? \[delegate, sendToCrew\] : \[\]\)/,
    'send_to_crew가 무게이트 등록됐거나 누락 — hop≥2에서도 노출되면 연쇄 상한이 뚫린다');
});

test('interval 루틴 — normalizeSchedule·isDue', async () => {
  const { normalizeSchedule, isDue } = await import('../src/routines.mjs');
  assert.deepEqual(normalizeSchedule({ type: 'interval', everyMinutes: 30 }), { type: 'interval', everyMinutes: 30 });
  assert.throws(() => normalizeSchedule({ type: 'interval', everyMinutes: 5 }), /10~1440/);
  assert.throws(() => normalizeSchedule({ type: 'interval', everyMinutes: 2000 }), /10~1440/);
  const r = { enabled: true, schedule: { type: 'interval', everyMinutes: 30 }, lastRun: null };
  assert.equal(isDue(r, new Date()), true, '첫 실행은 즉시 due');
  r.lastRun = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.equal(isDue(r, new Date()), false, '간격 미경과');
  r.lastRun = new Date(Date.now() - 31 * 60_000).toISOString();
  assert.equal(isDue(r, new Date()), true, '간격 경과');
  // 오염 방어 — 하한 미달 값이 파일에 직접 쓰였어도 발화하지 않는다
  assert.equal(isDue({ enabled: true, schedule: { type: 'interval', everyMinutes: 1 }, lastRun: null }, new Date()), false);
});
