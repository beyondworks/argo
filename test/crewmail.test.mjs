// 크루 우편함 — 적재·배달·유계 재시도·상한의 행위 테스트(실 fs, 임시 ARGO_ROOT).
// 배선(스케줄러·도구 등록)은 소스 스캔으로 잠근다("부품만 잠그고 배선 무방비" 교훈).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('선점 경합 — 두 배달 주체가 동시에 돌아도 배달은 1회(mkdir 게이트, 검수 CRITICAL-1)', async () => {
  // rename 단독 선점은 윈도우에서 상호배제가 아니다 — MoveFileEx 내부 "핸들 열기 → 핸들 rename"
  // TOCTOU로 겹친 두 rename이 둘 다 성공한다(2026-08-06 windows-latest 실측: 회차당 ~97% 이중 배달,
  // run 31085690668 간헐 실패의 뿌리). 단발이면 겹침이 안 난 회차가 통과해 플레이크가 되므로 반복한다.
  for (let i = 0; i < 30; i++) {
    await mod.sendCrewMail(WS, { from: 'a', fromName: '알파', to: 'race', message: `경합 검증 ${i}` });
    let calls = 0;
    const run = () => mod.deliverCrewMail(WS, async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); });
    await Promise.all([run(), run()]);
    assert.equal(calls, 1, `i=${i} 이중 배달 — 선점이 상호배제가 아니다`);
    assert.deepEqual(await mailFiles('race'), [], `i=${i} 선점 잔재(게이트·claimed)가 남았다`);
  }
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
  assert.match(s, /isCliRunner\(resolved\.runner\)/, '수신 러너 CLI 판정이 없다');
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
