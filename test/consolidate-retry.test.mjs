// 야간 기억 정리의 재시도 정책 가드 — PR #122 3R 검수 H2 후속.
//
// 배경: RUN_STAMP를 실행 **전에** 선점 기록하고(리더 겹침 이중 실행 방지) 실패해도 되돌리지
// 않아, 일시적 실패(429·네트워크·LLM JSON 파싱) 한 번에 그날 정리 + 주간 롤업이 영구 스킵됐다.
// 단순 롤백은 철회했다(커밋 5b4e94e): 종료 조건이 '성공'뿐이라 60초 폴마다 무한 재시도가 되고,
// 워터마크가 성공 후에만 전진하므로 영속적 실패는 같은 실패를 자정까지 ~1,200회 재현한다.
//
// 현 설계: 선점 시점에 nextRetryAt을 **미래로** 써둔다 → 실패해도 되돌릴 필요가 없고(스탬프가
// 하루 안에서 단조 전진) 겹친 리더는 백오프 창에 걸려 스킵한다. 상한 4회로 무계 재시도를 막는다.
// 이 파일이 잠그는 것: ① 유계 재시도·백오프 ② 성공 마킹의 CAS ③ 주간 롤업 append 멱등.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-consolidate-'));
const { paths } = await import('../src/workspace.mjs');
const { planConsolidate, claimConsolidate, markConsolidateDone, CONSOLIDATE_RETRY_MS, CONSOLIDATE_MAX_ATTEMPTS } = await import('../src/scheduler.mjs');
const { rollupJournals } = await import('../src/consolidate.mjs');

const TODAY = '2026-07-27';
const T0 = Date.parse(`${TODAY}T04:00:00Z`);

test('새 날: 1차 시도를 선점하고 다음 재시도를 미래로 예약한다', () => {
  const p = planConsolidate({ day: '2026-07-26', attempts: 4, done: false }, T0, TODAY);
  assert.equal(p.day, TODAY);
  assert.equal(p.attempts, 1, '어제 시도 소진과 무관하게 오늘은 1차부터');
  assert.equal(p.done, false);
  assert.ok(Date.parse(p.nextRetryAt) > T0, '선점 시점에 다음 재시도를 미래로 — 이게 롤백을 대신한다');
  assert.equal(Date.parse(p.nextRetryAt) - T0, CONSOLIDATE_RETRY_MS[0]);
  // 스탬프 자체가 없던 회사(첫 실행)도 같은 경로
  assert.equal(planConsolidate(null, T0, TODAY).attempts, 1);
  assert.equal(planConsolidate({}, T0, TODAY).attempts, 1);
});

test('백오프 창 안에서는 스킵 — 60초 폴이 재시도를 폭주시키지 않는다 (철회한 설계의 회귀 가드)', () => {
  const first = planConsolidate({}, T0, TODAY);
  // 폴은 60초마다 온다. 백오프(5분)가 끝나기 전 4회 폴 — 전부 스킵이어야 한다.
  for (const t of [60_000, 120_000, 180_000, 240_000]) {
    assert.equal(planConsolidate(first, T0 + t, TODAY), null, `+${t / 1000}s에 재시도가 돌면 폭주다`);
  }
  const second = planConsolidate(first, T0 + CONSOLIDATE_RETRY_MS[0], TODAY);
  assert.equal(second.attempts, 2, '백오프가 지나면 2차 시도');
  assert.equal(Date.parse(second.nextRetryAt) - (T0 + CONSOLIDATE_RETRY_MS[0]), CONSOLIDATE_RETRY_MS[1], '대기가 길어진다(지수)');
});

test('하루 상한: 소진 후에는 영속적 실패여도 더 돌지 않는다', () => {
  let st = {};
  let now = T0;
  const seen = [];
  for (let i = 0; i < 20; i += 1) { // 자정까지 폴이 계속 온다고 가정
    const p = planConsolidate(st, now, TODAY);
    if (p) { seen.push(p.attempts); st = p; }
    now += 60 * 60_000; // 1시간씩 — 어떤 백오프도 지난 시점
  }
  assert.deepEqual(seen, [1, 2, 3, 4], `하루 ${CONSOLIDATE_MAX_ATTEMPTS}회 상한`);
  assert.equal(st.nextRetryAt, null, '마지막 시도엔 다음 예약이 없다 — 오늘은 종료');
  assert.equal(planConsolidate(st, now, TODAY), null);
});

test('성공(done) 후에는 같은 날 다시 돌지 않는다', () => {
  const done = { day: TODAY, attempts: 2, nextRetryAt: null, done: true };
  assert.equal(planConsolidate(done, T0 + 10 * 60_000, TODAY), null);
  // 다음 날에는 재개
  assert.equal(planConsolidate(done, T0 + 86_400_000, '2026-07-28').attempts, 1);
});

test('미래 스탬프(기기 간 시계 어긋남)는 건드리지 않는다', () => {
  assert.equal(planConsolidate({ day: '2026-07-28', attempts: 1 }, T0, TODAY), null);
});

test('선점 스탬프는 겹친 리더를 막는다 — 판정 즉시 백오프 창이 서고, 그 창에서 두 번째 리더는 스킵', () => {
  const claimed = planConsolidate({}, T0, TODAY); // 리더 A가 선점
  assert.equal(planConsolidate(claimed, T0 + 1, TODAY), null, '리더 B가 1ms 뒤 같은 스탬프를 읽으면 스킵');
});

// ── 주간 롤업 멱등 (append 후 rename 실패 시 재실행이 같은 블록을 또 접던 것)
async function seedJournal(ws, name, body) {
  const p = paths(ws);
  await mkdir(p.journal, { recursive: true });
  await writeFile(join(p.journal, name), body);
}

test('롤업 멱등: 주간 블록이 이미 있으면 다시 append하지 않는다 (append→rename 부분 실패 회수)', async () => {
  const ws = 'rollup-idem';
  const old = '2026-07-01'; // 7일 컷오프보다 충분히 과거
  const file = `${old}-tester.md`;
  const body = `# ${old} 테스터 일지\n\n## 09:00 — 첫 작업\n내용\n`;
  await seedJournal(ws, file, body);
  const p = paths(ws);
  // 워터마크를 파일 크기까지 전진시켜 "정제 완료" 상태로 만든다(롤업 조건)
  await writeFile(join(p.vault, '.consolidate.json'),
    JSON.stringify({ v: 2, offsets: { [file]: Buffer.byteLength(body) } }));

  const r1 = await rollupJournals(ws);
  assert.equal(r1.rolled, 1);
  const weeklyName = (await readdir(p.journal)).find((n) => /^\d{4}-W\d{2}\.md$/.test(n));
  const after1 = await readFile(join(p.journal, weeklyName), 'utf8');
  assert.equal((after1.match(/^## 2026-07-01 /gm) ?? []).length, 1);

  // rename만 실패한 상황 재현 — 원본을 journal/에 되돌리고 롤업을 다시 돌린다
  await writeFile(join(p.journal, file), body);
  await rollupJournals(ws);
  const after2 = await readFile(join(p.journal, weeklyName), 'utf8');
  assert.equal((after2.match(/^## 2026-07-01 /gm) ?? []).length, 1,
    '같은 블록이 두 번 접히면 주간 일지가 재시도마다 부풀어 오른다');
});

test('롤업 멱등 키는 원본 파일명 — **동명 크루**의 하루치가 유실되지 않는다 (검수 실측 회귀)', async () => {
  // persona.mjs는 동명 영입을 허용한다(slug만 -2, 이름은 동일) → 표시 헤딩(날짜+이름)을 키로 쓰면
  // 두 번째 크루가 append 없이 아카이브돼 하루치가 통째로 사라진다. 이름을 같게 두는 게 이 테스트의 핵심.
  const ws = 'rollup-multi';
  const old = '2026-07-02';
  const a = `${old}-researcher.md`; const b = `${old}-researcher-2.md`;
  const bodyA = `# ${old} 리서처 일지\n\n## 09:00 — A 작업\n`;
  const bodyB = `# ${old} 리서처 일지\n\n## 10:00 — B 작업\n`;
  await seedJournal(ws, a, bodyA);
  await seedJournal(ws, b, bodyB);
  const p = paths(ws);
  await writeFile(join(p.vault, '.consolidate.json'), JSON.stringify({
    v: 2, offsets: { [a]: Buffer.byteLength(bodyA), [b]: Buffer.byteLength(bodyB) },
  }));

  await rollupJournals(ws);
  const weeklyName = (await readdir(p.journal)).find((n) => /^\d{4}-W\d{2}\.md$/.test(n));
  const text = await readFile(join(p.journal, weeklyName), 'utf8');
  assert.match(text, /09:00 — A 작업/, '첫 크루의 일지');
  assert.match(text, /10:00 — B 작업/, '동명 크루라 헤딩이 같다 — 파일명 키가 아니면 뒤 크루가 통째로 유실된다');
  assert.equal((await readdir(paths(ws).journal)).filter((f) => f.endsWith('.md') && !/^\d{4}-W/.test(f)).length, 0, '둘 다 아카이브됐어야');
});

// ── 파일 I/O 경로 — 순수함수만 보면 "선점을 실제로 기록하는가"가 무방비다(검수 M8)
test('claimConsolidate: 선점을 파일에 실제로 기록하고, 같은 창의 두 번째 호출은 null', async () => {
  const ws = 'claim-io';
  await mkdir(paths(ws).vault, { recursive: true });
  const first = await claimConsolidate(ws, T0, TODAY);
  assert.equal(first?.attempts, 1);
  const onDisk = JSON.parse(await readFile(join(paths(ws).vault, '.consolidate-run.json'), 'utf8'));
  assert.equal(onDisk.attempts, 1, '선점이 디스크에 없으면 겹친 리더·다음 폴이 즉시 또 돈다(무한 재시도 부활)');
  assert.ok(Date.parse(onDisk.nextRetryAt) > T0);
  assert.equal(await claimConsolidate(ws, T0 + 1_000, TODAY), null, '백오프 창 안 두 번째 선점은 거절');
});

test('markConsolidateDone: done만 세우고 attempts는 보존, 다른 날짜면 no-op (CAS)', async () => {
  const ws = 'done-io';
  await mkdir(paths(ws).vault, { recursive: true });
  const file = join(paths(ws).vault, '.consolidate-run.json');
  await writeFile(file, JSON.stringify({ day: TODAY, attempts: 3, nextRetryAt: null, done: false }));
  await markConsolidateDone(ws, TODAY);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.done, true);
  assert.equal(after.attempts, 3, 'attempts를 되감으면 오늘 재시도가 되살아난다');
  // 자정을 넘겨 끝난 실행 / 다른 기기가 새 날 스탬프를 올린 경우 — 덮어쓰면 안 된다
  await writeFile(file, JSON.stringify({ day: '2026-07-28', attempts: 1, done: false }));
  await markConsolidateDone(ws, TODAY);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).done, false, '남의 날짜 스탬프를 건드리면 안 된다');
});

test('오염된 attempts가 스케줄러 틱을 죽이지 않는다 (RETRY_MS 인덱스 이탈)', () => {
  for (const bad of [-5, 1.5, '3', 'abc', null, undefined, NaN, 1e9]) {
    assert.doesNotThrow(() => planConsolidate({ day: TODAY, attempts: bad }, T0, TODAY), `attempts=${bad}`);
  }
});

test('오염된 먼 미래 스탬프는 자가 회복한다 (영구 비활성화 방지)', () => {
  assert.equal(planConsolidate({ day: '2026-07-28' }, T0, TODAY), null, '하루 이내 미래 = 시계 어긋남, 양보');
  assert.equal(planConsolidate({ day: '9999-01-01' }, T0, TODAY)?.attempts, 1, '먼 미래 = 오염 — 그대로 두면 정리가 영영 안 돈다');
});

// ── 배선 트립와이어 — 스케줄러 콜백은 단위로 못 태운다(폴 루프·리스). 소스 스캔으로 잠근다.
test('배선: 스케줄러가 선점(claim)·성공 마킹(CAS)을 거치고, 무조건 선점 write가 없다', async () => {
  const src = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  // 틱은 id만 필요하다 — listCompanies는 전 크루·기억 md를 파싱해 60초 폴 × 전 기기에 비싸다(LOW-1)
  assert.match(src, /listCompanyIds\(\)/, '틱 회사 열거는 경량 listCompanyIds로');
  assert.doesNotMatch(src, /import \{[^}]*\blistCompanies\b[^}]*\}/, 'listCompanies 복귀 금지 — 틱마다 전 문서 파싱이 전 기기에서 돈다');
  assert.match(src, /claimConsolidate\(cid, now\.getTime\(\), today\)/, '선점은 판정+쓰기를 락 안에서 한 번에');
  assert.match(src, /markConsolidateDone\(cid, today\)/, '성공 후에만 done 마킹');
  assert.match(src, /if \(\(cur\.day \?\? ''\) !== today\) return;/, 'CAS — 남의 날짜 스탬프를 덮어쓰지 않는다(동기화 대상 파일)');
  // 철회한 설계의 재발 방지: 실패 catch에서 스탬프를 되돌리면 무한 재시도가 된다
  const catchBlock = src.split('기억 정리 실패')[1]?.slice(0, 300) ?? '';
  assert.doesNotMatch(catchBlock, /writeJsonAtomic\(RUN_STAMP/, '실패 경로에서 스탬프를 되돌리면 60초 폴마다 무한 재시도(5b4e94e에서 철회)');
  // 순서 — rollup **뒤**에 done. 앞에 오면 rollup 실패가 다시 '그날 영구 스킵'이 된다(검수 M12)
  assert.ok(src.indexOf('rollupJournals(cid)') < src.indexOf('markConsolidateDone(cid, today)'), 'done 마킹은 rollup 성공 후');
  // 실행이 백오프보다 길 때 다음 폴이 겹쳐 claim하는 것을 막는 in-flight 가드(검수 HIGH-2)
  assert.match(src, /consolidating\.has\(cid\) \? null : await claimConsolidate/, '진행 중이면 선점 자체를 하지 않는다');
  // add가 빠지면 Set이 영원히 비어 가드가 완전한 no-op이 된다 — has/finally만 보면 못 잡는다(2R M-2 변이 생존)
  assert.match(src, /consolidating\.add\(cid\)/, '선점 직후 진행 중 표시 — 이 한 줄이 가드의 전부다');
  assert.match(src, /\.finally\(\(\) => consolidating\.delete\(cid\)\)/, '완료 시 반드시 해제');
});

// ── SDK hang 상한 — in-flight 가드가 성립하려면 실행이 **반드시 끝나야** 한다(검수 2R M-1).
// SDK 경로엔 타임아웃이 없어 소켓 정체 시 async iterator가 영영 안 끝나고, 그러면 스케줄러의
// consolidating 표시가 안 풀려 그 회사 기억 정리가 무증상 영구 정지한다.
test('배선: oneshot SDK 경로에 hang 상한이 걸려 있고 타이머가 항상 해제된다', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.match(src, /abortController: ac/, 'SDK query에 중단 컨트롤러를 넘겨야 상한이 실효된다');
  assert.match(src, /hangGuard = setTimeout\(\(\) => ac\.abort\(\), timeoutMs\)/, 'hang 상한 타이머 — CLI와 같은 knob');
  assert.match(src, /finally \{\s*if \(hangGuard\) clearTimeout\(hangGuard\);/, '성공·실패·자가치유 어느 경로로 나가도 타이머를 남기면 안 된다');
});

test('러너 독립: SDK와 CLI가 같은 timeoutMs를 쓴다 (상한이 러너에 따라 갈리면 안 된다)', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /sdkTimeoutMs|SDK_HANG_LIMIT_MS/, 'SDK 전용 상한을 두면 같은 작업이 러너에 따라 잘리고 안 잘린다');
  assert.match(src, /externalExec\(\{[^}]*timeoutMs/s, 'CLI 경로도 같은 값');
});

test('중단 원인을 정직한 문구로 — "사용자가 중단"으로 읽히면 안 된다 (검수 M-1)', async () => {
  const src = await readFile(new URL('../src/oneshot.mjs', import.meta.url), 'utf8');
  // abort는 루프 안에서 throw하므로(SDK 실측: "process aborted by user") catch에서 갈아끼워야 실경로다
  assert.match(src, /catch \(err\)/, '원본 에러를 err로 받고');
  assert.match(src, /const e = ac\.signal\.aborted[\s\S]{0,200}sdk-timeout/, '중단이면 상한 초과로 치환 — 자가치유 로그·최종 안내가 모두 정직해진다');
});

test('상한은 호출부가 용도에 맞게 명시한다 — 통일된 knob 위에서 (검수 M-2·I-1)', async () => {
  const [oneshot, cons, persona, routines] = await Promise.all(
    ['../src/oneshot.mjs', '../src/consolidate.mjs', '../src/persona.mjs', '../src/routines.mjs']
      .map((f) => readFile(new URL(f, import.meta.url), 'utf8')));
  // 기본값 자체를 잠근다 — I-3: '호출부에 문자열이 있나'만 보면 기본값을 30분으로 바꿔도 안 잡힌다
  assert.match(oneshot, /timeoutMs = 120_000/, '명시 안 한 호출의 기본 상한');
  assert.match(cons, /runOneShot\([\s\S]{0,400}?timeoutMs: 10 \* 60_000/, '기억 정리 = 새벽 배치, 대기자 없음');
  // I-1: SDK 경로엔 이번에 처음 상한이 생긴다(이전 무제한). 첫 영입은 무료 모델(큐 지연) + 단일
  // 러너(자가치유 대체 없음) 조합이라 기본 120s면 온보딩이 통째로 실패할 수 있다.
  assert.match(persona, /CARD_PROMPT\([\s\S]{0,120}?timeoutMs: 5 \* 60_000/, '첫 영입은 기본보다 넉넉히');
  assert.match(routines, /runOneShot\([\s\S]{0,200}?timeoutMs: 3 \* 60_000/, '루틴 초안 — 90s는 SDK 경로엔 짧다');
});
