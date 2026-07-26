// 기억 인덱스 캐시(sqlite) 회귀 가드. 캐시의 유일한 계약은 "정본과 같은 산출물을 더 빨리"다 —
// 산출물이 갈리는 순간 캐시가 아니라 두 번째 정본이 되고, 그건 조용한 오정보다.
// 그래서 이 파일의 중심 테스트는 캐시 경로와 정본 전수 읽기 경로의 **바이트 동일성**이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  await w(p.notes, '배포-절차.md', '---\nupdated: 2026-03-01\n---\n# 배포 절차\n\n옛 절차.\n\n## 관련\n- [[notes/보안-원칙]]\n');
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
  assert.doesNotMatch(incremental, /손글씨/, '삭제된 문서가 인덱스에 남았다');
  assert.match(incremental, /새-노트/);
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
});

test('캐시 DB는 동기화 대상이 아니다 — 기기별 산출물이다', () => {
  for (const rel of ['.index.sqlite', '.index.sqlite-wal', '.index.sqlite-shm', '.index.sqlite-journal']) {
    assert.equal(EXCLUDE(rel), true, `${rel}이 동기화를 탄다`);
  }
  assert.equal(EXCLUDE('vault/notes/배포-절차.md'), false, '일반 노트가 제외됐다');
});

test('캐시가 문서 본문을 다시 읽지 않는다 — 안 바뀐 파일은 건드리지 않는다', async (t) => {
  if (!sqliteAvailable()) return t.skip('node:sqlite 없음');
  const p = await seed('c-noread');
  await updateIndex('c-noread');
  // 안 바뀐 파일의 atime/mtime을 과거로 고정 → 재스캔이 본문을 읽으면 atime이 올라간다
  const target = join(p.notes, '배포-절차.md');
  const fixed = new Date('2026-01-01T00:00:00Z');
  await utimes(target, fixed, fixed);
  await updateIndex('c-noread'); // mtime이 바뀌었으니 이번엔 읽는다(정상)
  const st1 = await stat(target);
  await updateIndex('c-noread'); // 이번엔 안 바뀜 → 읽지 않아야 한다
  const st2 = await stat(target);
  assert.equal(Math.round(st2.mtimeMs), Math.round(st1.mtimeMs), '재스캔이 파일 mtime을 건드렸다');
});
