// 기억 인덱스 캐시(sqlite) 회귀 가드. 캐시의 유일한 계약은 "정본과 같은 산출물을 더 빨리"다 —
// 산출물이 갈리는 순간 캐시가 아니라 두 번째 정본이 되고, 그건 조용한 오정보다.
// 그래서 이 파일의 중심 테스트는 캐시 경로와 정본 전수 읽기 경로의 **바이트 동일성**이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, stat } from 'node:fs/promises';
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
  process.env.ARGO_MEMINDEX = '0';                 // 정본 전수 읽기
  await updateIndex(ws);
  const plain = await readFile(p.index, 'utf8');
  delete process.env.ARGO_MEMINDEX;                // 캐시
  await updateIndex(ws);
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
  const blocker = new DatabaseSync(dbPath('c-busy'));       // 다른 연결이 쓰기 락을 점유
  blocker.exec('BEGIN EXCLUSIVE');
  try {
    await updateIndex('c-busy');                            // busy timeout 만료 → 경합으로 실패
    assert.ok(existsSync(dbPath('c-busy')), '경합을 손상으로 오인해 캐시를 지웠다');
    assert.ok((await readFile(p.index, 'utf8')).includes('## 주제 노트'), '경합 중 인덱스가 생성되지 않았다');
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
