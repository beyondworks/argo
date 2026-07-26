// 기억 인덱스 캐시(sqlite) 회귀 가드. 캐시의 유일한 계약은 "정본과 같은 산출물을 더 빨리"다 —
// 산출물이 갈리는 순간 캐시가 아니라 두 번째 정본이 되고, 그건 조용한 오정보다.
// 그래서 이 파일의 중심 테스트는 캐시 경로와 정본 전수 읽기 경로의 **바이트 동일성**이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

process.env.TZ = 'Asia/Seoul';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-memcache-'));
const { paths } = await import('../src/workspace.mjs');
const { updateIndex } = await import('../src/memory.mjs');
const { sqliteAvailable } = await import('../src/memindex.mjs');
const { EXCLUDE } = await import('../src/sync.mjs');

const dbPath = (ws) => join(paths(ws).root, '.index.sqlite');

/** 캐시 경로/정본 경로 각각으로 인덱스를 만들어 돌려준다. */
async function renderBoth(ws) {
  const p = paths(ws);
  await rm(dbPath(ws), { force: true });
  // 킬 스위치 해제는 반드시 finally — 중간에 예외가 나면 이후 모든 테스트가 정본 경로로만 돌아
  // 캐시 테스트 전체가 소리 없이 무력화된다(검수 F13). 이 파일의 존재 이유가 그걸 막는 것이다.
  process.env.ARGO_MEMINDEX = '0';                 // 정본 전수 읽기
  let plain;
  try { await updateIndex(ws); plain = await readFile(p.index, 'utf8'); }
  finally { delete process.env.ARGO_MEMINDEX; }
  await updateIndex(ws);                           // 캐시
  const cached = await readFile(p.index, 'utf8');
  return { plain, cached };
}

async function seed(ws) {
  const p = paths(ws);
  await mkdir(p.notes, { recursive: true });
  await mkdir(p.journal, { recursive: true });
  await mkdir(p.conversations, { recursive: true });
  const w = (dir, name, text, mtime) => writeFile(join(dir, name), text)
    .then(() => (mtime ? utimes(join(dir, name), new Date(mtime), new Date(mtime)) : null));
  // 링크 2개 — 링크 순서가 뒤집히는 회귀를 잡으려면 2개 이상이어야 한다(검수 H4-M9)
  await w(p.notes, '배포-절차.md', '---\nupdated: 2026-03-01\n---\n# 배포 절차\n\n옛 절차.\n\n## 관련\n- [[notes/보안-원칙]]\n- [[notes/손글씨]]\n');
  await w(p.notes, '배포-절차-3.md', '---\nupdated: 2026-07-25\n---\n# 배포 절차\n\n최신.\n');
  await w(p.notes, '손글씨.md', '# 손글씨 노트\n\nfrontmatter 없음.\n', '2026-07-10T09:00:00Z');
  await w(p.notes, '보안-원칙.conflict-devA-1753500000000.md', '# 보안 원칙\n\n갈라진 사본.\n');
  await w(p.journal, '2026-07-26-시원.md', '# 오늘 일지\n');
  await w(p.journal, '2026-W30.md', '# 주간 롤업\n');
  await w(p.conversations, '옛기록.md', '# 옛 기록\n');
  return p;
}

test('캐시 경로와 정본 경로의 인덱스 산출물이 바이트 동일하다', async () => {
  await seed('c-eq');
  const { plain, cached } = await renderBoth('c-eq');
  assert.equal(cached, plain, '캐시가 정본과 다른 인덱스를 만들었다');
  assert.match(cached, /## 주제 노트/);
  assert.match(cached, /## 동기화 충돌 사본/);
  // 상한 안내는 실제로 잘렸을 때만 — 노트 4개짜리 인덱스에 "최근 N개만 실었다"가 붙으면
  // 크루가 존재하지 않는 잘림을 찾아 나선다(검수 변이 M-A: 무조건 출력으로 바꿔도 초록이었다)
  assert.doesNotMatch(cached, /만 실었다/, '상한 미만인데 잘림 안내가 붙었다');
});

test('증분 갱신(추가·수정·삭제)이 전체 재구축과 같은 결과를 낸다', async () => {
  const p = await seed('c-incr');
  await updateIndex('c-incr');                                   // 캐시 최초 구축
  await writeFile(join(p.notes, '새-노트.md'), '---\nupdated: 2026-07-26\n---\n# 새 노트\n\n추가됨.\n');
  await writeFile(join(p.notes, '배포-절차-3.md'), '---\nupdated: 2026-07-27\n---\n# 배포 절차\n\n수정됨.\n');
  await rm(join(p.notes, '손글씨.md'));
  await updateIndex('c-incr');                                   // 증분
  const incremental = await readFile(p.index, 'utf8');
  await rm(dbPath('c-incr'), { force: true });
  await updateIndex('c-incr');                                   // 전체 재구축
  assert.equal(await readFile(p.index, 'utf8'), incremental, '증분 결과가 전체 재구축과 다르다');
  // 항목 줄만 본다 — 다른 노트의 "(관련: notes/손글씨)" 링크 텍스트에 걸리지 않게
  assert.doesNotMatch(incremental, /- \[\[notes\/손글씨\]\]/, '삭제된 문서가 인덱스에 남았다');
  assert.match(incremental, /- \[\[notes\/새-노트\]\]/);
});

test('DB를 지워도 정본에서 재구축된다 — 캐시는 버릴 수 있어야 한다', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-rebuild');
  await updateIndex('c-rebuild');
  const before = await readFile(p.index, 'utf8');
  assert.ok(existsSync(dbPath('c-rebuild')), '캐시 DB가 만들어지지 않았다');
  await rm(dbPath('c-rebuild'), { force: true });
  await updateIndex('c-rebuild');
  assert.equal(await readFile(p.index, 'utf8'), before);
});

test('DB가 손상돼도 인덱스는 정상 생성된다 (지우고 재구축)', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-corrupt');
  await updateIndex('c-corrupt');
  const before = await readFile(p.index, 'utf8');
  await writeFile(dbPath('c-corrupt'), 'not a database at all');  // 손상 주입
  await updateIndex('c-corrupt');
  assert.equal(await readFile(p.index, 'utf8'), before, '손상된 캐시에서 인덱스가 깨졌다');
  // 제목이 약속한 "지우고 재구축"까지 확인한다 — 내용만 보면 폴백만 살아 있어도 통과한다(검수 H4-M8).
  await updateIndex('c-corrupt');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(dbPath('c-corrupt'));
  const rows = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n;
  db.close();
  assert.ok(rows > 0, '손상된 DB가 재구축되지 않았다(폴백만 동작 중)');
});

// 링크는 문서에 적힌 순서 그대로 나와야 한다. 캐시/정본 동등성만으로는 못 잡는다 —
// 양쪽이 같은 docMeta를 쓰므로 순서가 뒤집혀도 나란히 뒤집힌다(검수 H4-M9).
test('관련 링크가 문서에 적힌 순서대로 나온다', async () => {
  const p = await seed('c-linkorder');
  await updateIndex('c-linkorder');
  assert.match(await readFile(p.index, 'utf8'), /\(관련: notes\/보안-원칙, notes\/손글씨\)/, '링크 순서가 문서와 다르다');
});

// 다른 프로세스가 쓰기 락을 쥐고 있으면 경합이 난다. 경합은 손상이 아니다 — 이걸 손상으로 오인해
// DB를 지우면 다음 턴이 전 문서 재구축을 물고, 재구축이 락을 더 오래 쥐어 충돌을 부른다(검수 H1).
test('쓰기 경합에서는 캐시를 지우지 않는다 (경합 ≠ 손상)', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-busy');
  await updateIndex('c-busy');
  assert.ok(existsSync(dbPath('c-busy')));
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  // 무변경 턴은 이제 쓰기문 자체가 없어 락을 안 잡는다(검수 HIGH-3 반영) — 경합을 일으키려면
  // 실제 변경이 있어야 쓰기 단계(BEGIN IMMEDIATE)에 도달한다.
  await writeFile(join(p.notes, '경합-중-쓴-노트.md'), '---\nupdated: 2026-07-26\n---\n# 경합 중\n');
  const blocker = new DatabaseSync(dbPath('c-busy'));       // 다른 연결이 쓰기 락을 점유
  blocker.exec('BEGIN EXCLUSIVE');
  try {
    const t0 = Date.now();
    await updateIndex('c-busy');                            // 즉시 busy → 정본 폴백 (대기 금지)
    const elapsed = Date.now() - t0;
    // busy 대기는 동기 API라 이벤트 루프 정지다 — 타임아웃을 되살리면(5s든 60s든) 여기서 잡힌다
    assert.ok(elapsed < 3000, `경합에서 ${elapsed}ms — busy 대기가 되살아났다(즉시 폴백이어야 한다)`);
    assert.ok(existsSync(dbPath('c-busy')), '경합을 손상으로 오인해 캐시를 지웠다');
    const idx = await readFile(p.index, 'utf8');
    assert.ok(idx.includes('## 주제 노트'), '경합 중 인덱스가 생성되지 않았다');
    assert.match(idx, /경합-중-쓴-노트/, '폴백 경로가 새 문서를 놓쳤다'); // 폴백은 캐시와 무관하게 정확해야 한다
  } finally { blocker.exec('ROLLBACK'); blocker.close(); }
});

// 인덱스는 크루의 첫 화면이자 컨텍스트에 통째로 들어간다. 노트가 수만 개면 수만 줄이 되어 읽히지도
// 담기지도 않는다(2026-07-26 유건 결정: 상한 도입). 잘린 나머지는 사라지는 게 아니라 Grep으로 찾는다 —
// 그 사실을 인덱스가 명시해야 크루가 "없다"고 단정하지 않는다.
test('주제 노트가 상한을 넘으면 최신순으로 자르고, 잘렸다는 사실과 찾는 법을 밝힌다', async () => {
  const p = await seed('c-cap');
  for (let i = 0; i < 260; i++) {
    const day = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`;
    await writeFile(join(p.notes, `대량-${String(i).padStart(3, '0')}.md`), `---\nupdated: ${day}\n---\n# 대량 ${i}\n`);
  }
  await updateIndex('c-cap');
  const idx = await readFile(p.index, 'utf8');
  const noteSection = idx.split('## 최근 일지')[0];
  const entries = [...noteSection.matchAll(/^- \[\[notes\//gm)].length;
  assert.equal(entries, 200, `상한이 적용되지 않았다(항목 ${entries}개)`);
  assert.match(noteSection, /최근 200개만 실었다/);
  assert.match(noteSection, /나머지 \d+개도 그대로 남아 있으니/);
  assert.match(noteSection, /Grep으로 찾아라/);
  // 잘려도 최신이 남아야 한다 — 가장 최근(2026-07-25) 노트가 살아 있는지
  assert.match(noteSection, /- \[\[notes\/배포-절차-3\]\]/, '상한이 최신 노트를 잘라냈다');
  // 캐시/정본 동등성은 상한 적용 후에도 유지되어야 한다
  const { plain, cached } = await renderBoth('c-cap');
  assert.equal(cached, plain);
});

// :3001 단일 프로세스에서 웹 턴과 텔레그램 턴이 겹치는 건 기본값이다(mutex.mjs가 기정사실로 문서화).
// busy timeout으로 기다리면 동기 API가 이벤트 루프를 세우고, 락을 쥔 쪽은 그 루프가 있어야 진행하므로
// 자기 자신과의 데드락 = 타임아웃 만료가 보장된다(검수 CRITICAL: 5초 전면 정지 실측 — HTTP·게이트웨이·
// 스케줄러 동반 정지). 올바른 구현은 인프로세스 직렬화(withLock)라 동시 턴이 빠르게 순차 완료된다.
test('같은 프로세스 동시 턴이 이벤트 루프를 세우지 않는다 (5초 데드락 회귀 가드)', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-parallel');
  await updateIndex('c-parallel'); // 캐시 예열 — 경합은 예열 후 무변경 턴에서도 났다
  let maxGap = 0; let last = Date.now();
  const tick = setInterval(() => { const now = Date.now(); if (now - last > maxGap) maxGap = now - last; last = now; }, 25);
  const t0 = Date.now();
  await Promise.all([updateIndex('c-parallel'), updateIndex('c-parallel'), updateIndex('c-parallel')]);
  const elapsed = Date.now() - t0;
  clearInterval(tick);
  // 결함 구현은 5초 타임아웃 만료가 "보장"이라 하한이 5,000ms다 — 4,000ms 경계는 머신이 느려도 오탐 없다
  assert.ok(elapsed < 4000, `동시 턴 3개에 ${elapsed}ms — busy 대기가 이벤트 루프를 잡고 있다`);
  assert.ok(maxGap < 1500, `이벤트 루프 최대 정지 ${maxGap}ms — 서버 전체가 멈추는 시간이다`);
  assert.ok(existsSync(dbPath('c-parallel')), '동시 턴 경합으로 캐시가 삭제됐다');
  const { plain, cached } = await renderBoth('c-parallel');
  assert.equal(cached, plain, '동시 턴 후 캐시와 정본이 갈렸다');
});

// 읽을 수 없는 문서를 캐시는 옛 값으로 계속 보여주고 폴백은 통째로 뺐다 — 같은 입력에 다른 산출물은
// 이 캐시의 유일한 계약 위반이다(검수 HIGH-4). 둘 다 뺀다: 인덱서가 못 읽는 파일은 크루도 못 읽으므로
// 실어두는 것 자체가 거짓 약속이고, 행이 없으면 다음 스캔이 자동 재시도한다.
test('읽을 수 없게 된 문서는 두 경로 모두 인덱스에서 뺀다', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root는 권한 검사를 우회한다');
  const p = await seed('c-unreadable');
  await updateIndex('c-unreadable');                       // 예열 — 캐시에 옛 내용의 행이 존재
  const f = join(p.notes, '배포-절차.md');
  await writeFile(f, '# 배포 절차\n\n갱신된 내용(읽기 불가가 될 판).\n'); // stale로 만들고
  await chmod(f, 0o000);                                   // 읽기 불가
  try {
    await updateIndex('c-unreadable');                     // 캐시 경로
    const cached = await readFile(p.index, 'utf8');
    process.env.ARGO_MEMINDEX = '0';
    let plain;
    try { await updateIndex('c-unreadable'); plain = await readFile(p.index, 'utf8'); } // 정본 폴백 경로
    finally { delete process.env.ARGO_MEMINDEX; }          // 예외 시에도 킬 스위치 잔존 금지(검수 F13)
    assert.equal(cached, plain, '읽기 실패에서 캐시와 정본 산출물이 갈렸다');
    assert.doesNotMatch(cached, /- \[\[notes\/배포-절차\]\]/, '읽을 수 없는 문서가 옛 값으로 인덱스에 남았다');
  } finally { await chmod(f, 0o644); }
});

// 충돌 사본 상한은 최신순으로 잘라야 한다 — rel 순서 그대로 자르면 가장 최근 충돌이 잘려 나가는데,
// 이 섹션의 지시("확인 후 병합하고 지워라")가 정확히 최근 충돌부터 보라는 뜻이다(검수 MEDIUM-6, 변이 M-B).
test('충돌 사본이 상한을 넘으면 최신순으로 자르고 잘림을 밝힌다', async () => {
  const p = await seed('c-confcap');                       // seed에 충돌 1개(mtime=지금, 가장 최신) 포함
  for (let i = 0; i < 26; i++) {
    const f = join(p.notes, `옛-${String(i).padStart(2, '0')}.conflict-devA-${1753000000000 + i}.md`);
    await writeFile(f, `# 옛 ${i}\n`);
    const when = new Date(Date.parse('2026-07-01T00:00:00Z') - i * 3600_000); // i가 클수록 과거
    await utimes(f, when, when);
  }
  await updateIndex('c-confcap');
  const section = (await readFile(p.index, 'utf8')).split('## 동기화 충돌 사본')[1] ?? '';
  const entries = [...section.matchAll(/^- \[\[notes\//gm)].length;
  assert.equal(entries, 20, `충돌 사본 상한이 적용되지 않았다(항목 ${entries}개)`);
  assert.match(section, /외 7개 더/);                       // 총 27(시드 1 + 26) − 20
  assert.match(section, /보안-원칙\.conflict/, '가장 최근 충돌이 잘려 나갔다 — 최신순 절단이 아니다');
  assert.doesNotMatch(section, /옛-25\.conflict/, '가장 오래된 충돌이 상한 안에 남았다');
});

// mtime 밀리초 반올림이 한쪽에만 있으면 동일자 타이브레이크가 두 경로에서 갈린다(검수 LOW, 변이 M-C).
// 서브밀리초 차이는 나는데 반올림하면 같은 두 노트로 재현한다 — rel 순서를 raw mtime 순서와 반대로 두어,
// 반올림이 빠지면 정렬이 뒤집히게 만든다.
test('mtime 반올림이 두 경로에서 일치한다 (동일자 타이브레이크 분기 가드)', async (t) => {
  const ws = 'c-subms';
  const p = paths(ws);
  await mkdir(p.notes, { recursive: true });
  await mkdir(p.journal, { recursive: true });
  const baseSec = Date.parse('2026-07-20T12:00:00+09:00') / 1000;
  const aa = join(p.notes, '가나-노트.md');
  const zz = join(p.notes, '하하-노트.md');
  await writeFile(aa, '# 가나\n');                          // frontmatter 없음 → mtime 폴백 경로
  await writeFile(zz, '# 하하\n');
  // +0.4ms / +0.1ms — 반올림하면 같은 정수 ms가 되는 서브밀리초 차이(µs 해상도 안, rel이 앞서는 쪽이 raw가 크다)
  await utimes(aa, baseSec + 0.0004, baseSec + 0.0004);
  await utimes(zz, baseSec + 0.0001, baseSec + 0.0001);
  const [sa, sz] = [await stat(aa), await stat(zz)];
  if (sa.mtimeMs === sz.mtimeMs || Math.round(sa.mtimeMs) !== Math.round(sz.mtimeMs)) {
    return t.skip('파일시스템이 서브밀리초 mtime을 보존하지 않는다 — 이 가드는 APFS 계열 전용');
  }
  const { plain, cached } = await renderBoth(ws);
  assert.equal(cached, plain, '서브밀리초 mtime에서 두 경로의 타이브레이크가 갈렸다(반올림 불일치)');
});

// HIGH-3 구조 불변식: 무변경 턴은 쓰기 락을 전혀 잡지 않는다. 동시 턴 이벤트 루프 정지(CRITICAL)를
// 실제로 닫은 다리가 이것이다 — 3라운드 검수가 결함(트랜잭션이 스캔 전체를 덮는 구조)을 복원해도
// 기존 테스트 전부가 초록임을 보였다(복합 가드의 필수 다리가 단독 무방비). 판별력: 프로브 실측
// busy 0 vs 94(결함 복원 시). 외부 연결이 2ms 간격으로 배타 락을 시도하며 실패 수를 센다.
test('무변경 턴은 쓰기 락을 전혀 잡지 않는다 (HIGH-3 구조 불변식)', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const ws = 'c-lockwin';
  const p = paths(ws);
  await mkdir(p.notes, { recursive: true });
  await mkdir(p.journal, { recursive: true });
  const batch = [];
  for (let i = 0; i < 1500; i++) { // 스캔이 프로브 간격보다 충분히 길어야 결함 복원 시 busy가 쌓인다
    batch.push(writeFile(join(p.notes, `주제-${String(i).padStart(4, '0')}.md`), `---\nupdated: 2026-0${(i % 9) + 1}-01\n---\n# 주제 ${i}\n`));
    if (batch.length >= 500) { await Promise.all(batch); batch.length = 0; }
  }
  await Promise.all(batch);
  await updateIndex(ws); // 최초 구축
  await updateIndex(ws); // 체크포인트 안정화 — 구축 직후 잔여 쓰기가 프로브에 오탐되지 않게
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const probe = new DatabaseSync(dbPath(ws));
  let busy = 0, tries = 0;
  const tick = setInterval(() => {
    tries++;
    try { probe.exec('BEGIN IMMEDIATE'); probe.exec('COMMIT'); } catch { busy++; }
  }, 2);
  for (let i = 0; i < 10; i++) await updateIndex(ws); // 무변경 턴 10회
  clearInterval(tick);
  probe.close();
  assert.ok(tries > 20, `프로브가 충분히 돌지 않았다(${tries}회) — 판별 불가`);
  assert.ok(busy <= 2, `무변경 턴 중 외부 쓰기 락 실패 ${busy}/${tries}회 — 스캔이 배타 락을 쥐고 있다(HIGH-3 회귀)`);
});

// 폴더가 통째로 안 읽히면(권한 회수·마운트 이탈) 삭제가 아니라 장애다 — 행을 쓸어내면 그 턴의 인덱스가
// 침묵 속에 비고, 회복 후 전량 재구축을 문다(3라운드 검수 F3: 행 6→1 침묵 정리 + 경고 0 재현).
// 행을 보존하고 이번 턴만 정본 폴백한다 — 폴백도 같은 장애를 겪으므로 산출물 동등성은 실패 모드에서도 유지된다.
test('폴더가 통째로 안 읽히면 행을 보존하고 이번 턴만 정본 폴백한다', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  if (process.getuid?.() === 0) return t.skip('root는 권한 검사를 우회한다');
  const p = await seed('c-dirout');
  await updateIndex('c-dirout');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const countRows = () => { const db = new DatabaseSync(dbPath('c-dirout')); const n = db.prepare('SELECT COUNT(*) AS n FROM docs').get().n; db.close(); return n; };
  const before = countRows();
  assert.ok(before > 0, '예열 실패');
  const healthy = await readFile(p.index, 'utf8');
  await chmod(p.notes, 0o000);                               // notes 폴더 자체를 읽기 불가로
  try {
    await updateIndex('c-dirout');                           // 캐시 → 불건전 감지 → 정본 폴백
    const cached = await readFile(p.index, 'utf8');
    process.env.ARGO_MEMINDEX = '0';
    let plain;
    try { await updateIndex('c-dirout'); plain = await readFile(p.index, 'utf8'); }
    finally { delete process.env.ARGO_MEMINDEX; }
    assert.equal(cached, plain, '장애 모드에서 캐시와 정본 산출물이 갈렸다');
    assert.equal(countRows(), before, '폴더 장애에서 캐시 행이 삭제됐다 — 회복 시 전량 재구축을 문다');
  } finally { await chmod(p.notes, 0o755); }
  await updateIndex('c-dirout');                             // 회복 — 보존된 행으로 즉시 복귀해야 한다
  assert.equal(await readFile(p.index, 'utf8'), healthy, '회복 후 인덱스가 장애 전과 다르다');
  assert.equal(countRows(), before);
});

test('캐시 DB는 동기화 대상이 아니다 — 기기별 산출물이다', () => {
  for (const rel of ['.index.sqlite', '.index.sqlite-wal', '.index.sqlite-shm', '.index.sqlite-journal']) {
    assert.equal(EXCLUDE(rel), true, `${rel}이 동기화를 탄다`);
  }
  assert.equal(EXCLUDE('vault/notes/배포-절차.md'), false, '일반 노트가 제외됐다');
});

// 이 커밋의 존재 이유(안 바뀐 파일은 안 읽는다)를 지키는 유일한 테스트다.
// 앞선 두 판이 무력했다: ① atime을 말하고 mtime을 단언(항상 참) ② 읽기 실패는 옛 행을 남겨 산출물이
// 안 변하므로 구분 불가. 이번엔 **mtime·size를 그대로 둔 채 내용만 바꾼다** — 올바른 구현은 이를
// 건너뛰어 옛 제목이 남고, 매번 다시 읽는 구현은 새 제목이 나온다(검수 H4-M1).
test('안 바뀐 것으로 보이는 파일은 다시 읽지 않는다', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-noread');
  await updateIndex('c-noread');
  const f = join(p.notes, '배포-절차.md');
  const orig = await readFile(f, 'utf8');
  const st = await stat(f);
  const sneaky = orig.replace('# 배포 절차', '# 배포 규정'); // 절차→규정: 같은 바이트 수
  assert.equal(Buffer.byteLength(sneaky), Buffer.byteLength(orig), '시드가 같은 크기가 아니다');
  await writeFile(f, sneaky);
  await utimes(f, st.mtime, st.mtime);                        // mtime까지 원복 → 캐시 눈엔 무변경
  await updateIndex('c-noread');
  const idx = await readFile(p.index, 'utf8');
  assert.match(idx, /— 배포 절차 /, '안 바뀐(것으로 보이는) 파일을 다시 읽었다 — 증분 갱신이 무의미하다');
  assert.doesNotMatch(idx, /배포 규정/);
});

// 변경 판정 키가 mtime+size라, 크기가 같은 수정은 mtime으로만 잡힌다. mtime을 키에서 빼면 통째로 샌다.
// 앞선 판은 끝에서 renderBoth()가 DB를 지우고 재구축해 증분 버그를 가렸다(검수 H4-M3).
test('크기가 같은 수정도 잡아낸다 (mtime이 판정 키에 있어야 한다)', async () => {
  const p = await seed('c-samesize');
  await updateIndex('c-samesize');
  const f = join(p.notes, '배포-절차.md');
  const orig = await readFile(f, 'utf8');
  const edited = orig.replace('# 배포 절차', '# 배포 규정'); // 같은 바이트 수, mtime은 갱신됨
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(orig));
  await writeFile(f, edited);
  await updateIndex('c-samesize');
  assert.match(await readFile(p.index, 'utf8'), /배포 규정/, '크기가 같은 수정을 놓쳤다');
});

// 링크만 덧붙이는 쓰기는 mtime을 되돌린다(writeKeepingMtime). 링크 섹션은 append가 아니라 재조립이라
// 중복 링크가 제거되며 크기가 줄 수 있고, 새 링크가 늘린 만큼과 상쇄되면 mtime·size가 **둘 다** 같아진다.
// 그러면 캐시는 변경을 영영 못 본다 — invalidatePath가 그 구멍을 막는다(검수 H3·H4-M10).
test('mtime·크기가 모두 그대로인 링크 갱신도 캐시에 반영된다', async () => {
  const p = await seed('c-invalidate');
  const f = join(p.notes, '중복링크.md');
  // 근거 링크가 중복 등재된 상태 — aaa 한 줄이 제거되며 같은 길이의 bbb 한 줄과 상쇄된다
  await writeFile(f, '# 중복 링크\n\n본문.\n\n## 근거\n- [[journal/aaa]]\n- [[journal/aaa]]\n');
  await updateIndex('c-invalidate');
  const st = await stat(f);
  const { appendSourceLinks } = await import('../src/memory.mjs');
  await appendSourceLinks(f, ['journal/bbb']);
  const after = await stat(f);
  assert.equal(after.size, st.size, '전제 불성립: 크기가 상쇄되지 않았다');
  assert.equal(Math.round(after.mtimeMs), Math.round(st.mtimeMs), '전제 불성립: mtime이 보존되지 않았다');
  await updateIndex('c-invalidate');
  assert.match(await readFile(p.index, 'utf8'), /journal\/bbb/, 'mtime·크기가 같은 링크 갱신을 캐시가 놓쳤다');
});

// 스키마가 바뀌면 마이그레이션하지 않고 버린다. 앞선 판은 행을 지우기만 해서, 검사를 빼도 refresh가
// 빈 테이블을 그냥 다시 채워 통과했다. 이번엔 **틀린 값이 든 행**을 남긴다 — 버리지 않으면 그 값이 샌다.
test('스키마 버전이 바뀌면 통째로 재구축한다 (마이그레이션하지 않는다)', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-schema');
  await updateIndex('c-schema');
  const before = await readFile(p.index, 'utf8');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(dbPath('c-schema'));
  db.prepare("UPDATE meta SET v = 'old' WHERE k = 'schema_version'").run();
  // mtime·size는 실제 파일과 맞는 채 제목만 오염 → 증분 스캔은 이 행을 건드리지 않는다
  db.prepare("UPDATE docs SET title = '옛 스키마 잔재' WHERE rel = 'notes/배포-절차.md'").run();
  db.close();
  await updateIndex('c-schema');
  const idx = await readFile(p.index, 'utf8');
  assert.doesNotMatch(idx, /옛 스키마 잔재/, '스키마 불일치인데 옛 데이터가 살아남았다');
  assert.equal(idx, before);
});
