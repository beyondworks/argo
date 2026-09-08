// 크루 우편함 — 적재·배달·유계 재시도·상한의 행위 테스트(실 fs, 임시 ARGO_ROOT).
// 배선(스케줄러·도구 등록)은 소스 스캔으로 잠근다("부품만 잠그고 배선 무방비" 교훈).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readdir, readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey(); // 전체 봉투 기본 켜짐 — 계정 키 없으면 EXCLUDE가 전체를 보류한다
import { channelSends } from '../src/channel-events.mjs'; // 슬랙 타입 게이트를 행동으로 단언(순수 모듈이라 정적 임포트 안전)

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

test('mailPrompt — to는 회신 안내, cc는 회신 의무 없음, hop≥2는 회신 지시 금지', () => {
  const to = mod.mailPrompt({ kind: 'to', fromName: '알파', message: 'x', hop: 1 });
  const cc = mod.mailPrompt({ kind: 'cc', fromName: '알파', message: 'x', hop: 1 });
  assert.match(to, /send_to_crew/); assert.match(to, /답장/);
  assert.match(cc, /참조/); assert.doesNotMatch(cc, /send_to_crew/);
  // hop≥2 배달 턴은 colleagues가 빈 배열 = 도구 미등록 — 존재하지 않는 도구를 지시하면 안 된다(검수 HIGH-2)
  const h2 = mod.mailPrompt({ kind: 'to', fromName: '알파', message: 'x', hop: 2 });
  assert.doesNotMatch(h2, /send_to_crew/, 'hop 2 배달 턴에 회신 지시가 남아 있다');
});

test('mailPrompt hasTools:false — CLI 러너 수신 턴에 send_to_crew 지시 금지(HIGH-2와 동일 사고)', () => {
  // 수신 크루가 외부 CLI 러너(codex/gemini/antigravity)면 hop<2여도 도구가 없다(검수 MEDIUM 2026-07-28)
  for (const lang of ['ko', 'en']) {
    const t = mod.mailPrompt({ kind: 'to', fromName: '알파', message: 'x', hop: 0 }, lang, { hasTools: false });
    assert.doesNotMatch(t, /send_to_crew/, `${lang}: 도구 없는 수신 턴에 회신 지시 혼입`);
    assert.ok(t.includes('알파'), `${lang}: 본문 프레임은 유지`);
  }
});

test('선점 경합 — 두 배달 주체가 동시에 돌아도 배달은 1회(rename 원자성, 검수 CRITICAL-1)', async () => {
  await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'race', message: '경합 검증' });
  let calls = 0;
  const run = () => mod.deliverCrewMail(WS, async () => { calls += 1; await new Promise((r) => setTimeout(r, 40)); });
  await Promise.all([run(), run()]);
  assert.equal(calls, 1, '이중 배달 — 선점이 상호배제가 아니다');
  assert.deepEqual(await mailFiles('race'), []);
});

test('cc 상한 — CC_MAX 초과는 통째로 거절(팬아웃 총량 방어, 검수 MEDIUM)', async () => {
  await assert.rejects(
    () => mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'z', cc: ['c1', 'c2', 'c3', 'c4', 'c5'], message: 'x' }),
    /참조는/);
});

test('동기화 제외 — mail/은 로컬 큐다(검수 CRITICAL-2, .gw-queue 선례)', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  assert.equal(EXCLUDE('mail/beta/m123-to.json'), true, 'mail/이 동기화를 타면 리더 교체 시 이중 배달');
  assert.equal(EXCLUDE('mail/.dead/x.json'), true);
  assert.equal(EXCLUDE('vault/files/mail.txt'), false, '일반 파일명 mail은 제외 대상이 아니다');
});

test('회신 예외 — 직전 발신자는 colleagues에 남는다(검수 HIGH-2, 소스 계약)', () => {
  const src = read('src/chat.mjs');
  assert.match(src, /a\.slug === lastSender/, '직전 발신자 회신 허용이 사라졌다 — 쪽지 왕복이 다시 불가능해진다');
});

test('유계 재시도 — 실패는 attempts 증가, 소진 시 dead/로 이동(조용한 소실 금지)', async () => {
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'b', message: '실패 유도' });
  for (let i = 0; i < mod.MAIL_MAX_ATTEMPTS; i++) {
    await mod.deliverCrewMail(WS, async () => { throw new Error('runner down'); });
  }
  assert.deepEqual(await mailFiles('b'), [], '소진된 메시지가 우편함에 남아 무한 재시도된다');
  const dead = await readdir(join(paths(WS).root, 'mail', '.dead'));
  assert.ok(dead.some((f) => f.includes(id)), '.dead/에 없다 — 무증상 소실');
  const rec = JSON.parse(await readFile(join(paths(WS).root, 'mail', '.dead', dead.find((f) => f.includes(id))), 'utf8'));
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
  assert.match(s, /deliverCrewMail\(cid/, '스케줄러 배달 배선이 없다 — 쪽지가 영영 배달되지 않는다');
  assert.match(s, /appendTurn\(cid, slug/, '수신 턴이 스레드에 안 남는다 — 사장이 대화를 못 본다');
  // 검수 변이 실험에서 이 가드 제거가 미감지였다 — 틱 겹침(LLM 턴 > 60s)이면 같은 회사에 배달
  // 루프가 이중 진입해 rename 경합·이중 배달 조건이 된다(HIGH-4). 트립와이어로 잠근다.
  assert.match(s, /mailDelivering\.has\(cid\)/, '틱 겹침 이중 진입 가드(HIGH-4)가 사라졌다');
});

test('배선 — 배달 알림이 게이트웨이 문안까지 이어진다(재검 N1 보류 해소)', () => {
  const s = read('src/scheduler.mjs');
  assert.match(s, /emitNotify\(\{ type: 'crewmail'/, '배달 알림 발신이 없다 — 메신저로 쪽지 결과가 안 간다');
  const g = read('src/gateway.mjs');
  assert.match(g, /event\.type === 'crewmail'/, 'pushEvent에 crewmail 분기가 없다 — 알림이 무동작(재검 N1 원상복귀)');
  // 분기가 **있어도** 그 안이 부르는 것이 임포트돼 있지 않으면 매 호출 ReferenceError로 죽고
  // notify.mjs의 .catch가 삼켜 무음 실패가 된다 — 실제로 listAgents 임포트가 빠져 크루 쪽지 브리핑이
  // 100% 안 갔다(전수 검사 2026-07-30). 위 정규식은 분기 존재만 봐서 이걸 못 잡았다.
  // 근본 처방은 eslint no-undef이고(이 계열 전체를 잡는다), 그때까지 이 단언이 자리를 지킨다.
  for (const id of ['listAgents']) {
    assert.ok(new RegExp(`import \\{[^}]*\\b${id}\\b[^}]*\\} from`).test(g),
      `gateway.mjs가 ${id}를 쓰는데 임포트가 없다 — 호출 시 ReferenceError(무음 실패)`);
  }
  // 슬랙 경로는 문안 있는 타입만 — 게이트가 풀리면 job·crewmail에서 event.routine.title TypeError가 재발한다.
  // 리터럴 삼항을 물던 앵커에서 **행동 단언**으로 바꿨다(판정이 channel-events로 옮겨감): 불변식은 같고,
  // 정당한 리팩터에 거짓 red를 내지 않으면서 실제 게이트가 풀리면 잡는다.
  assert.match(g, /sends\('slack', s\)/, '슬랙 전송이 채널 판정을 안 지난다');
  assert.equal(channelSends('slack', { enabled: true }, 'crewmail'), false, '슬랙에 쪽지가 나가면 문안이 없어 TypeError');
  assert.equal(channelSends('slack', { enabled: true }, 'job'), false, '슬랙에 작업완료도 문안이 없다');
  assert.equal(channelSends('slack', { enabled: true }, 'routine'), true, '문안 있는 종류는 그대로 나간다');
});

test('배선 — 우편 배달은 클라우드 리더 게이트를 타지 않는다(기기 로컬 큐)', () => {
  const s = readFileSync(join(root, 'src/scheduler.mjs'), 'utf8');
  // mail/은 동기화 제외 기기 로컬 큐 — 발신(send_to_crew)엔 리더 게이트가 없어 아무 기기나 자기
  // 큐에 쌓는다. 배달에 isCloudLeader가 걸리면 비리더 기기 발신분이 attempts 0인 채 영영 미배달
  // (dead-letter로도 못 감)되는 무증상 소실이 된다(architect 검증 2026-07-28).
  // 옛 리터럴 금지가 아니라 "조기 반환 ~ 배달 호출 사이에 cloudLeader 차단이 없다"는 **구간 불변식**으로
  // 잠근다 — 문법만 바꾼 재게이트(if (!cloudLeader) return·continue, 가드 재감쌈, 피연산자 뒤집기)가
  // 리터럴 단언 전부를 통과하는 것이 변이 8종 실측으로 확인됐다(분리 검수 MEDIUM-1).
  assert.match(s, /if \(!lease\.isLeader\(\)\) return;/,
    '프로세스 단위 리더 게이트(daemonLease)는 유지해야 한다 — 같은 기기 내 이중 배달 방어');
  const i = s.indexOf('if (!lease.isLeader()) return;');
  const j = s.indexOf('deliverCrewMail(cid');
  assert.ok(i >= 0 && j > i, '틱 배선이 사라졌다 — 쪽지가 영영 배달되지 않는다');
  const seg = s.slice(i, j); // 조기 반환 ~ 배달 호출 사이엔 어떤 형태의 cloudLeader 차단도 없어야 한다
  assert.doesNotMatch(seg, /!cloudLeader/,
    '우편 앞에 cloudLeader 차단(return·continue)이 생겼다 — 비리더 기기 발신분 무증상 소실');
  assert.doesNotMatch(seg, /isCloudLeader\(\)\s*\)/,
    '조기 반환·조건이 isCloudLeader를 직접 문의한다 — 우편까지 게이트에 걸린다');
  assert.equal((seg.match(/if \(cloudLeader\)/g) ?? []).length, 1,
    '루틴 블록 게이트 1개만 허용 — 우편 블록 재감쌈·회사 루프 게이트 금지');
  assert.match(seg, /\n\s*if \(!mailDelivering\.has\(cid\)\) \{/,
    '배달 진입 가드가 오염됐다(cloudLeader 혼입 등) — 가드는 in-flight 여부만 본다');
  // 기억 정리는 여전히 기기 간 단일 실행(cloudLeader)이어야 한다 — 게이트 전면 해제 금지
  assert.match(s, /cloudLeader && hhmm >= CONSOLIDATE_AT/,
    '기억 정리가 클라우드 리더 게이트를 잃었다 — 다기기 동시 정리');
});

test('배선 — 스케줄러가 수신 크루 러너를 판정해 mailPrompt에 hasTools를 전달한다', () => {
  // 판정 없이 mailPrompt(msg)만 부르면 CLI 러너 수신 크루가 없는 send_to_crew 지시를 받는다(검수 MEDIUM 2026-07-28)
  const s = read('src/scheduler.mjs');
  assert.match(s, /isCliTurn\(resolved\.runner, await runnerCredType\(cid, resolved\.runner\)\)/, '수신 러너 CLI 판정(자격 축)이 없다');
  assert.match(s, /mailPrompt\(msg, 'ko', \{ hasTools \}\)/, 'mailPrompt에 hasTools 미전달');
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

// ── 쪽지함 화면용 조작(listMail·cancelMail·requeueDead·deleteDead) + 배달 기록
test('listMail — pending(대기·배달 중)·dead·log 구조', async () => {
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'lm', cc: ['lm2'], message: '목록 검증' });
  const { rename } = await import('node:fs/promises');
  // lm2의 사본을 배달 중(.claimed)으로 위장 — 화면은 claimed:true로 구분해야 한다
  await rename(join(paths(WS).root, 'mail', 'lm2', `${id}-cc.json`), join(paths(WS).root, 'mail', 'lm2', `${id}-cc.json.claimed`));
  const r = await mod.listMail(WS);
  assert.ok(Array.isArray(r.pending) && Array.isArray(r.dead) && Array.isArray(r.log));
  const to = r.pending.find((m) => m.id === id && m.to === 'lm');
  const cc = r.pending.find((m) => m.id === id && m.to === 'lm2');
  assert.equal(to.kind, 'to'); assert.equal(to.claimed, false); assert.equal(to.fromName, '알파'); assert.equal(to.attempts, 0);
  assert.equal(cc.kind, 'cc'); assert.equal(cc.claimed, true);
  assert.ok(r.dead.some((d) => d.corrupt !== true && d.attempts === mod.MAIL_MAX_ATTEMPTS && d.to === 'b'), '앞 테스트의 소진 기록이 dead에 구조화돼야 한다');
});

test('cancelMail — 대기는 삭제·기록, 배달 중(.claimed)은 거부', async () => {
  const r = await mod.listMail(WS);
  const to = r.pending.find((m) => m.to === 'lm');
  const cc = r.pending.find((m) => m.to === 'lm2');
  await assert.rejects(() => mod.cancelMail(WS, 'lm2', cc.id), /배달 중/);
  assert.deepEqual(await mailFiles('lm2'), [`${cc.id}-cc.json.claimed`], '거부됐으면 파일은 그대로');
  await mod.cancelMail(WS, 'lm', to.id);
  assert.deepEqual(await mailFiles('lm'), []);
  const log = (await mod.listMail(WS)).log;
  assert.ok(log.some((l) => l.id === to.id && l.ok === false && l.error === 'cancelled'), '취소가 배달 기록에 남아야 한다');
});

test('배달 기록 — 성공·실패가 각각 한 줄(최신순)', async () => {
  const ok = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'log1', message: '성공' });
  await mod.deliverCrewMail(WS, async () => {});
  const bad = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'log2', message: '실패' });
  await mod.deliverCrewMail(WS, async () => { throw new Error('runner down'); });
  const { log } = await mod.listMail(WS);
  const okRow = log.find((l) => l.id === ok);
  const badRow = log.find((l) => l.id === bad);
  assert.equal(okRow.ok, true); assert.equal(okRow.to, 'log1'); assert.equal(okRow.attempts, 1);
  assert.equal(badRow.ok, false); assert.match(badRow.error, /runner down/); assert.equal(badRow.attempts, 1);
  assert.ok(log.indexOf(badRow) < log.indexOf(okRow), '최신이 앞');
  const raw = await readFile(join(paths(WS).root, 'mail', '.log.jsonl'), 'utf8');
  assert.ok(raw.trim().split('\n').every((l) => JSON.parse(l).ts), 'jsonl 각 줄에 ts');
});

test('requeueDead — 실패함 기록이 attempts 0·lastError 없이 원래 우편함으로', async () => {
  const { dead } = await mod.listMail(WS);
  const rec = dead.find((d) => d.to === 'b' && !d.corrupt);
  const r = await mod.requeueDead(WS, rec.file);
  assert.equal(r.to, 'b');
  assert.deepEqual(await mailFiles('b'), [`${rec.id}-to.json`]);
  const body = JSON.parse(await readFile(join(paths(WS).root, 'mail', 'b', `${rec.id}-to.json`), 'utf8'));
  assert.equal(body.attempts, 0); assert.equal(body.lastError, undefined); assert.equal(body.message, '실패 유도');
  assert.ok(!(await readdir(join(paths(WS).root, 'mail', '.dead'))).includes(rec.file), '.dead에서 사라져야 한다');
  await mod.cancelMail(WS, 'b', rec.id); // 정리
});

test('deleteDead — 기록 삭제, .corrupt도 삭제 가능', async () => {
  const { writeFile } = await import('node:fs/promises');
  const deadDir = join(paths(WS).root, 'mail', '.dead');
  await writeFile(join(deadDir, 'zz-m1-to.json.corrupt'), '{broken');
  const before = await mod.listMail(WS);
  assert.ok(before.dead.some((d) => d.file === 'zz-m1-to.json.corrupt' && d.corrupt === true));
  await assert.rejects(() => mod.requeueDead(WS, 'zz-m1-to.json.corrupt'), /파일명/);
  await mod.deleteDead(WS, 'zz-m1-to.json.corrupt');
  assert.ok(!(await readdir(deadDir)).includes('zz-m1-to.json.corrupt'));
});

test('경로 검증 — slug·id·파일명에 구분자·상위 경로·dot 접두는 거부', async () => {
  await assert.rejects(() => mod.cancelMail(WS, '../b', 'm1abc'), /slug/);
  await assert.rejects(() => mod.cancelMail(WS, '.dead', 'm1abc'), /slug/);
  await assert.rejects(() => mod.cancelMail(WS, 'b', '../x'), /id/);
  await assert.rejects(() => mod.cancelMail(WS, 'b', 'm1/x'), /id/);
  await assert.rejects(() => mod.requeueDead(WS, '../company.json'), /파일명/);
  await assert.rejects(() => mod.requeueDead(WS, 'b-m1-to.json/../x'), /파일명/);
  await assert.rejects(() => mod.deleteDead(WS, '../company.json'), /파일명/);
  await assert.rejects(() => mod.deleteDead(WS, '.log.jsonl'), /파일명/);
  // 저장 관문 — 쪽지함 API가 화면 입력을 그대로 넘기므로 sendCrewMail 자체가 막아야 한다
  await assert.rejects(() => mod.sendCrewMail(WS, { from: 'captain', to: '../x', message: 'x' }), /slug/);
  await assert.rejects(() => mod.sendCrewMail(WS, { from: 'captain', to: 'b', cc: ['.dead'], message: 'x' }), /slug/);
});

/* ── .claimed 회수는 고정 창이 아니라 소유 프로세스의 **자기 심박(mtime)** 기준 — 제보 2026-09-08 "1시간 넘게 배달 안 됨"(크래시 뒤 3시간 갇힘).
   분리 검수 HIGH-1(각인 시각)·HIGH-2(남의 상태 파일 의존)·MEDIUM-1(회수 시 attempts) 반영. ── */

const claimAs = async (slug, { mtimeAgoMs, attempts = 0 }) => {
  const { rename, writeFile, utimes } = await import('node:fs/promises');
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: slug, message: '회수 시나리오' });
  const p = join(paths(WS).root, 'mail', slug, `${id}-to.json`);
  const body = JSON.parse(await readFile(p, 'utf8'));
  await writeFile(p, JSON.stringify({ ...body, attempts, claimedAt: new Date(Date.now() - 12 * 60_000).toISOString() }));
  await rename(p, `${p}.claimed`); // 다른(죽은) 프로세스가 선점한 흔적 — 이 프로세스의 inFlight에 없다
  const t = new Date(Date.now() - mtimeAgoMs); await utimes(`${p}.claimed`, t, t); // 심박 = mtime
  return { id, claimed: `${p}.claimed` };
};
const rcCalls = [];
// 앞 테스트가 남긴 다른 슬러그의 대기분은 시나리오 밖 — rc-* 만 세고, 틱 상한도 넉넉히(검수 LOW-3: readdir 순서 의존 제거)
const rcRun = () => mod.deliverCrewMail(WS, async (slug) => { if (slug.startsWith('rc-')) rcCalls.push(slug); }, { limit: 10 });

test('.claimed 회수 — 심박(mtime) 5분 끊김 → 이 틱에 .json 복귀(attempts +1·사유), 다음 틱 배달', async () => {
  const { id } = await claimAs('rc-dead', { mtimeAgoMs: 5 * 60_000 });
  await rcRun();
  assert.deepEqual(await mailFiles('rc-dead'), [`${id}-to.json`], '회수: .claimed → .json');
  const body = JSON.parse(await readFile(join(paths(WS).root, 'mail', 'rc-dead', `${id}-to.json`), 'utf8'));
  assert.equal(body.attempts, 1, '회수도 한 번의 시도로 센다(검수 MEDIUM-1 — 독성 쪽지 무계 재시도 방지)');
  assert.match(body.lastError, /회수/);
  assert.deepEqual(rcCalls, [], '회수한 틱에는 배달하지 않는다(다음 틱)');
  await rcRun();
  assert.deepEqual(rcCalls, ['rc-dead'], '다음 틱에 배달');
  assert.deepEqual(await mailFiles('rc-dead'), []);
});

test('.claimed 보존 — 다른 프로세스의 자기 심박(mtime 최신)이 있으면 claimedAt이 12분 전이어도 손대지 않고, 심박이 끊기면 회수', async () => {
  const { utimes } = await import('node:fs/promises');
  const { id, claimed } = await claimAs('rc-live', { mtimeAgoMs: 0 });
  await rcRun();
  assert.deepEqual(await mailFiles('rc-live'), [`${id}-to.json.claimed`], 'mtime이 신선하면 보존(이중 배달 방지) — claimedAt(JSON)은 판정에 안 쓴다');
  const t = new Date(Date.now() - 4 * 60_000); await utimes(claimed, t, t); // 심박 끊김
  await rcRun();
  assert.deepEqual(await mailFiles('rc-live'), [`${id}-to.json`], '심박 끊긴 뒤 회수');
});

test('.claimed 보존 — 심박 1분 전(선점 직후 창)은 건드리지 않는다', async () => {
  const { id } = await claimAs('rc-fresh', { mtimeAgoMs: 60_000 });
  await rcRun();
  assert.deepEqual(await mailFiles('rc-fresh'), [`${id}-to.json.claimed`], '3분 미만은 보존');
});

test('회수가 시도 상한을 채우면 다음 틱에 턴 없이 .dead로 — 프로세스를 죽이는 쪽지가 3분마다 턴을 태우지 않는다', async () => {
  const { id } = await claimAs('rc-poison', { mtimeAgoMs: 5 * 60_000, attempts: mod.MAIL_MAX_ATTEMPTS - 1 });
  await rcRun(); // 회수 → attempts = MAX
  await rcRun(); // 소진 선확인 → .dead, runTurn 미호출
  assert.ok(!rcCalls.includes('rc-poison'), '턴을 태우지 않는다');
  assert.deepEqual(await mailFiles('rc-poison'), []);
  assert.ok((await readdir(join(paths(WS).root, 'mail', '.dead'))).includes(`rc-poison-${id}-to.json`), '실패함으로');
});

test('배달 중 자기 심박 — 턴이 도는 동안 .claimed mtime이 전진하고, claimedAt은 실제 선점 시각(틱 시작 now가 아니라)으로 각인된다(검수 HIGH-1)', async () => {
  mod._setClaimHeartbeatMsForTest(20);
  try {
    const { stat } = await import('node:fs/promises');
    await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-hb', message: '앞 턴(느림)' });
    await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-hb', message: '뒤 쪽지' });
    const seen = [];
    const t0 = Date.now();
    await mod.deliverCrewMail(WS, async (slug, msg) => {
      const p = join(paths(WS).root, 'mail', slug, `${msg.id}-to.json.claimed`);
      const m0 = (await stat(p)).mtimeMs;
      await new Promise((r) => setTimeout(r, 150)); // 심박 20ms가 여러 번 돈다
      if (slug === 'rc-hb') seen.push({ advanced: (await stat(p)).mtimeMs > m0, claimedAt: Date.parse(JSON.parse(await readFile(p, 'utf8')).claimedAt), at: Date.now() }); // 앞 테스트 잔여분 제외(검수 LOW-3)
    }, { limit: 10, concurrency: 1, now: t0 }); // 순차 강제 — 동시 배달(기본)에선 크루가 다르면 같이 시작해 이 시나리오가 안 생긴다
    assert.equal(seen.length, 2);
    assert.ok(seen.every((x) => x.advanced), '턴 도중 mtime 전진(자기 심박)');
    const later = seen.sort((a, b) => a.at - b.at)[1];
    assert.ok(later.claimedAt >= t0 + 150 - 5, `뒤 쪽지 claimedAt은 앞 턴(≥150ms) 뒤의 실제 선점 시각이어야 한다(실측 +${later.claimedAt - t0}ms) — 틱 시작 now로 각인하면 red`);
  } finally { mod._setClaimHeartbeatMsForTest(30_000); }
});

test('동시 배달 — 회의실처럼 한 패스의 쪽지가 동시에 돌고(동시 진행 ≥2, 총 소요 ≈ 1건), 상한 2면 동시 진행이 2를 넘지 않는다(유건 지시 2026-09-08)', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let inflight = 0; let max = 0;
  const run = (concurrency) => mod.deliverCrewMail(WS, async () => { inflight += 1; max = Math.max(max, inflight); await sleep(120); inflight -= 1; }, { limit: 10, concurrency });
  for (const s of ['rc-p1', 'rc-p2', 'rc-p3', 'rc-p4']) await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: s, message: '동시' });
  const t0 = Date.now();
  await run(8);
  assert.ok(max >= 2, `동시 진행 최대 ${max} — 순차면 1`);
  assert.ok(Date.now() - t0 < 4 * 120, `총 소요 ${Date.now() - t0}ms — 순차(≥480ms)가 아니다(판별선은 순차 최소치, 상한 완화는 fs 오버헤드 여유)`);
  assert.deepEqual(await mailFiles('rc-p3'), []);
  max = 0;
  for (const s of ['rc-p1', 'rc-p2', 'rc-p3', 'rc-p4']) await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: s, message: '상한' });
  await run(2);
  assert.equal(max, 2, `상한 2 — 동시 진행 최대 ${max}`);
  assert.ok(mod.MAIL_CONCURRENCY >= 1 && mod.MAIL_CONCURRENCY <= 16 && mod.MAIL_PER_TICK === mod.MAIL_CONCURRENCY, '기본 상한은 1~16 클램프, 패스당 착수 상한 = 동시 상한');
});

test('같은 크루 앞으로 온 쪽지는 그 크루 안에서 순차, 크루 간에만 동시 — 한 크루의 동시 턴은 상태 파일을 서로 지운다(2R 검수 HIGH-1)', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inflight = {}; const max = {}; let total = 0; let totalMax = 0;
  for (const m of ['a', 'b', 'c']) await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-same', message: m });
  await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-other', message: 'x' });
  await mod.deliverCrewMail(WS, async (slug) => {
    inflight[slug] = (inflight[slug] ?? 0) + 1; max[slug] = Math.max(max[slug] ?? 0, inflight[slug]); total += 1; totalMax = Math.max(totalMax, total);
    await sleep(80);
    inflight[slug] -= 1; total -= 1;
  }, { limit: 10, concurrency: 8 });
  assert.equal(max['rc-same'], 1, `같은 크루 동시 턴 최대 ${max['rc-same']} — 반드시 1`);
  assert.ok(totalMax >= 2, `크루 간 동시 진행 ${totalMax} — rc-same 그룹과 rc-other가 겹쳐야 한다`);
  assert.deepEqual(await mailFiles('rc-same'), []);
});

test('실패 정착은 .claimed가 아직 내 것일 때만 — 다른 프로세스가 회수·배달해 사라진 쪽지를 부활시키지 않는다(2R 검수 MEDIUM-3)', async () => {
  const { rm } = await import('node:fs/promises');
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-gone', message: '부활 금지' });
  await mod.deliverCrewMail(WS, async (slug, msg) => {
    if (slug !== 'rc-gone') return;
    await rm(join(paths(WS).root, 'mail', slug, `${msg.id}-to.json.claimed`), { force: true }); // 다른 프로세스가 회수해 배달까지 끝낸 상황
    throw new Error('옛 소유자의 늦은 실패');
  }, { limit: 10 });
  assert.deepEqual(await mailFiles('rc-gone'), [], '큐에 되살아나면 안 된다(이중 배달)');
  assert.ok(!(await readdir(join(paths(WS).root, 'mail', '.dead')).catch(() => [])).some((f) => f.includes(id)), '실패함에도 안 간다');
});

test('예산 게이트 — 월 지출 한도에 닿았으면 그 패스는 순차(동시 1)로 접는다(2R 검수 MEDIUM-2, 회의실 라운드 경계 게이트와 같은 규칙)', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { appendUsage } = await import('../src/usage.mjs');
  const B = 'lean-test-mail-budget';
  await mkdir(paths(B).root, { recursive: true });
  await writeFile(paths(B).company, JSON.stringify({ id: B, name: '예산', budgetUsd: 1 }));
  await appendUsage(B, { kind: 'chat', slug: 'x1', runner: 'claude', model: 'm', usage: {}, costUsd: 5, ms: 10, billed: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let inflight = 0; let max = 0;
  for (const s of ['x1', 'x2', 'x3']) await mod.sendCrewMail(B, { from: 'a', fromName: '알파', to: s, message: '한도' });
  await mod.deliverCrewMail(B, async () => { inflight += 1; max = Math.max(max, inflight); await sleep(60); inflight -= 1; }, { limit: 10, concurrency: 8 });
  assert.equal(max, 1, `한도 도달 시 동시 진행 최대 ${max} — 순차여야 한다(초과 폭 1턴)`);
});

test('대기 선점분도 자기 심박 — 앞 크루 턴이 도는 동안 아직 착수 안 한 다른 크루의 .claimed mtime이 전진한다(3R 검수 조건 2, MEDIUM-4 잠금)', async () => {
  mod._setClaimHeartbeatMsForTest(20);
  try {
    const { stat } = await import('node:fs/promises');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-w1', message: '앞' });
    await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-w2', message: '뒤(대기)' });
    let advanced = null;
    await mod.deliverCrewMail(WS, async (slug) => {
      if (advanced !== null || !slug.startsWith('rc-w')) return;
      const other = slug === 'rc-w1' ? 'rc-w2' : 'rc-w1';
      const f = (await mailFiles(other)).find((x) => x.endsWith('.claimed'));
      const p = join(paths(WS).root, 'mail', other, f);
      const m0 = (await stat(p)).mtimeMs; await sleep(120);
      advanced = (await stat(p)).mtimeMs > m0; // 대기 중인 상대의 .claimed가 심박을 받고 있는가
    }, { limit: 10, concurrency: 1 });
    assert.equal(advanced, true, '대기 선점분의 mtime이 멈춰 있으면 다른 프로세스가 3분 뒤 회수해 이중 배달 — 심박은 선점 시점부터');
  } finally { mod._setClaimHeartbeatMsForTest(30_000); }
});

test('착수는 크루별 라운드로빈 — 한 크루에 밀린 백로그가 다른 크루 쪽지를 막지 않는다(3R 검수 MEDIUM-B)', async () => {
  for (const m of ['1', '2', '3']) await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-rr1', message: m });
  await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-rr2', message: 'x' });
  const calls = [];
  await mod.deliverCrewMail(WS, async (slug) => { if (slug.startsWith('rc-rr')) calls.push(slug); }, { limit: 2 });
  assert.equal(new Set(calls).size, 2, `첫 패스(상한 2)에 서로 다른 크루 2명이 들어가야 한다(열거 순서 무관 — 4R 검수 LOW-2) — 실제 ${calls.join(',')}`);
  assert.equal(calls.filter((s) => s === 'rc-rr1').length, 1);
  const order = mod.pendingRoundRobin([{ slug: 'a', file: '1' }, { slug: 'a', file: '2' }, { slug: 'b', file: '1', claimed: true }, { slug: 'b', file: '2' }, { slug: 'c', file: '1' }]).map((x) => `${x.slug}${x.claimed ? '*' : ''}${x.file}`);
  assert.deepEqual(order, ['b*1', 'a1', 'b2', 'c1', 'a2'], '잔재 먼저, 그 뒤 슬러그별 한 건씩');
  await mod.deliverCrewMail(WS, async () => {}, { limit: 10 }); // 잔여 정리
});

test('선점 신원(claimBy) — 회수 → 재선점 → 아직 착수 전인 남의 claim을 옛 소유자의 늦은 실패가 되돌리지 않는다(4R 검수 MEDIUM-1)', async () => {
  const { rename, writeFile, rm } = await import('node:fs/promises');
  const id = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-steal', message: '신원' });
  const dir = join(paths(WS).root, 'mail', 'rc-steal');
  const claimed = join(dir, `${id}-to.json.claimed`);
  await mod.deliverCrewMail(WS, async (slug) => {
    if (slug !== 'rc-steal') return;
    // 다른 프로세스가 회수(신원 제거·attempts+1)하고 재선점했으나 아직 각인 전 — 옛 claimedAt은 남고 claimBy만 새것
    const body = JSON.parse(await readFile(claimed, 'utf8'));
    await rename(claimed, join(dir, `${id}-to.json`));
    await rename(join(dir, `${id}-to.json`), claimed);
    await writeFile(claimed, JSON.stringify({ ...body, claimBy: 'other-process', attempts: 1 }));
    throw new Error('옛 소유자의 늦은 실패');
  }, { limit: 10 });
  assert.deepEqual(await mailFiles('rc-steal'), [`${id}-to.json.claimed`], '남의 claim을 .json으로 되돌리면(뺏으면) 이중 배달');
  assert.equal(JSON.parse(await readFile(claimed, 'utf8')).claimBy, 'other-process', '내용도 그대로');
  await rm(claimed, { force: true }); // 뒤 테스트 상태 정리
  // 실제 pre-stamp 모양: 회수가 신원을 뗀 뒤 재선점만 된 상태(claimBy 부재) — "부재면 내 것" 폴백을 되살리면 여기서 red(5R 검수 LOW-B)
  const id2 = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-steal', message: '신원 부재' });
  const claimed2 = join(dir, `${id2}-to.json.claimed`);
  await mod.deliverCrewMail(WS, async (slug) => {
    if (slug !== 'rc-steal') return;
    const { claimBy: _b, claimedAt: _a, ...stripped } = JSON.parse(await readFile(claimed2, 'utf8'));
    await writeFile(claimed2, JSON.stringify({ ...stripped, attempts: 1 }));
    throw new Error('옛 소유자의 늦은 실패');
  }, { limit: 10 });
  assert.deepEqual(await mailFiles('rc-steal'), [`${id2}-to.json.claimed`], '신원이 없어도 내 것으로 단정하지 않는다');
  await rm(claimed2, { force: true });
});

test('착수 전 소유권 검사 — 대기 중 다른 프로세스에 회수·재선점된 claim은 각인·턴을 건너뛴다(5R 검수 후속)', async () => {
  const { writeFile } = await import('node:fs/promises');
  await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-o1', message: '앞' });
  const id2 = await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'rc-o2', message: '뒤(대기 중 뺏김)' });
  const calls = [];
  await mod.deliverCrewMail(WS, async (slug) => {
    if (!slug.startsWith('rc-o')) return;
    calls.push(slug);
    if (slug === 'rc-o1') { // 앞 턴 도중 대기 중인 rc-o2가 다른 프로세스에 회수·재선점됨(다른 토큰)
      const p = join(paths(WS).root, 'mail', 'rc-o2', `${id2}-to.json.claimed`);
      const body = JSON.parse(await readFile(p, 'utf8'));
      await writeFile(p, JSON.stringify({ ...body, claimBy: 'other-process' }));
    }
  }, { limit: 10, concurrency: 1 });
  assert.deepEqual(calls, ['rc-o1'], 'rc-o2는 남의 것이 됐으므로 턴을 돌리지 않는다(돌리면 이중 배달)');
  const p = join(paths(WS).root, 'mail', 'rc-o2', `${id2}-to.json.claimed`);
  assert.equal(JSON.parse(await readFile(p, 'utf8')).claimBy, 'other-process', '남의 claim은 그대로');
  const { rm } = await import('node:fs/promises'); await rm(p, { force: true }); // 정리
});

test('회수(reclaimClaim)는 옛 소유자의 claimBy·claimedAt을 떼고 되돌린다 — 재선점자가 각인하기 전에도 옛 신원이 남지 않는다', async () => {
  const { id } = await claimAs('rc-strip', { mtimeAgoMs: 5 * 60_000 });
  const p = join(paths(WS).root, 'mail', 'rc-strip', `${id}-to.json`);
  const { writeFile, rename, utimes } = await import('node:fs/promises');
  const b0 = JSON.parse(await readFile(`${p}.claimed`, 'utf8'));
  await writeFile(`${p}.claimed`, JSON.stringify({ ...b0, claimBy: 'dead-owner' }));
  const t = new Date(Date.now() - 5 * 60_000); await utimes(`${p}.claimed`, t, t); // 쓰기가 갱신한 mtime을 다시 과거로(심박 끊김)
  await rcRun();
  const b = JSON.parse(await readFile(p, 'utf8'));
  assert.equal(b.claimBy, undefined); assert.equal(b.claimedAt, undefined); assert.equal(b.attempts, 1);
  await rename(p, `${p}.claimed`); const { rm } = await import('node:fs/promises'); await rm(`${p}.claimed`, { force: true }); // 정리
});
