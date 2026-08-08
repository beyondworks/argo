// 주제 노트 인덱스 정렬 회귀 가드 — 크루의 기억 진입점(_index.md)에서 같은 주제의 최신 절차가
// 옛 절차보다 위에 와야 한다. 예전엔 파일명(주제 슬러그) 정렬이라 순서에 시간 정보가 0이었고,
// 3월 절차가 7월 절차보다 위에 오는 일이 실제로 났다(2026-07-26 실측).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TZ = 'Asia/Seoul'; // 날짜 절단이 로컬 기준인지 보려면 TZ가 고정돼야 한다(UTC와 갈리는 시간대)

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-memidx-'));
const { paths } = await import('../src/workspace.mjs');
const { updateIndex, noteDate, localDay } = await import('../src/memory.mjs');

const doc = (text, mtimeMs = 0) => ({ text, mtimeMs });

test('noteDate: frontmatter updated가 1순위이고 exact로 표시된다', () => {
  assert.deepEqual(noteDate(doc('---\nupdated: 2026-07-25\n---\n# 제목\n')), { date: '2026-07-25', exact: true });
});

test('noteDate: CRLF·BOM·따옴표·선행공백 frontmatter도 인식한다', () => {
  assert.equal(noteDate(doc('---\r\nupdated: 2026-06-06\r\n---\r\n')).date, '2026-06-06');
  assert.equal(noteDate(doc('﻿---\nupdated: 2026-06-07\n---\n')).date, '2026-06-07');
  assert.equal(noteDate(doc('---\nupdated: "2026-06-08"\n---\n')).date, '2026-06-08');
  assert.equal(noteDate(doc('---\n  updated: 2026-06-10\n---\n')).date, '2026-06-10');
});

test('noteDate: frontmatter가 없으면 mtime 폴백이되 exact=false(추정)로 표시한다', () => {
  const ms = Date.parse('2026-07-26T09:00:00Z'); // KST 18:00 — UTC로 잘라도 같은 날이라 날짜 자체는 안 흔들린다
  assert.deepEqual(noteDate(doc('# 크루가 손으로 쓴 노트\n', ms)), { date: '2026-07-26', exact: false });
});

// 날짜 절단은 로컬 기준이어야 한다 — UTC로 자르면 KST 오전에 쓴 글이 '어제'로 표기된다.
// 기대값을 localDay()로 만들면 UTC로 회귀해도 양변이 같이 움직여 통과한다(동어반복) → 문자열을 박는다.
test('localDay: KST 새벽에 쓴 글이 어제로 밀리지 않는다 (UTC 회귀 가드)', () => {
  assert.equal(localDay(Date.parse('2026-07-26T00:30:00+09:00')), '2026-07-26'); // UTC면 2026-07-25
  assert.equal(localDay(Date.parse('2026-07-26T08:59:00+09:00')), '2026-07-26'); // UTC면 2026-07-25
  assert.equal(localDay(Date.parse('2026-07-26T23:30:00+09:00')), '2026-07-26'); // 양쪽 동일 — 경계 밖 대조군
});

test('noteDate: 본문에 있는 updated는 frontmatter로 오인하지 않는다', () => {
  const ms = Date.parse('2020-01-08T12:00:00+09:00');
  assert.equal(noteDate(doc('# 제목\n\nupdated: 2099-12-31\n', ms)).date, '2020-01-08');
});

/** notes/ 아래에 노트를 만들고 mtime을 고정한다. */
async function seed(ws, files) {
  const p = paths(ws);
  await mkdir(p.notes, { recursive: true });
  await mkdir(p.journal, { recursive: true });
  for (const [name, text, mtime] of files) {
    const f = join(p.notes, name);
    await writeFile(f, text);
    if (mtime) await utimes(f, new Date(mtime), new Date(mtime));
  }
  return p;
}

test('같은 주제 3벌이 갱신일 최신순으로 나온다 (예전엔 3월 절차가 맨 위였다)', async () => {
  const p = await seed('t-order', [
    ['배포-절차.md', '---\nupdated: 2026-03-01\n---\n# 배포 절차\n\n옛 절차.\n'],
    ['배포-절차-2.md', '---\nupdated: 2026-05-20\n---\n# 배포 절차\n\n중간 절차.\n'],
    ['배포-절차-3.md', '---\nupdated: 2026-07-25\n---\n# 배포 절차\n\n최신 절차.\n'],
  ]);
  await updateIndex('t-order');
  const idx = await readFile(p.index, 'utf8');
  const order = [...idx.matchAll(/- \[\[notes\/(.+?)\]\]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['배포-절차-3', '배포-절차-2', '배포-절차']);
});

test('갱신일이 같으면 mtime이 최근인 쪽이 위 — 파일명 정렬로 깨면 v1이 항상 최상단이 된다', async () => {
  const day = localDay();
  const p = await seed('t-tie', [
    ['배포-절차.md', `---\nupdated: ${day}\n---\n# 배포 절차\n\n오전에 고친 구버전.\n`, '2026-07-26T00:00:00Z'],
    ['배포-절차-3.md', `---\nupdated: ${day}\n---\n# 배포 절차\n\n오후에 만든 신버전.\n`, '2026-07-26T09:00:00Z'],
  ]);
  await updateIndex('t-tie');
  const idx = await readFile(p.index, 'utf8');
  const order = [...idx.matchAll(/- \[\[notes\/(.+?)\]\]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['배포-절차-3', '배포-절차']);
});

test('mtime 폴백 노트는 "추정"으로 표기하고, frontmatter 노트는 단정한다', async () => {
  const p = await seed('t-label', [
    ['확정.md', '---\nupdated: 2026-07-20\n---\n# 확정\n'],
    ['추정.md', '# 추정\n', '2026-07-10T09:00:00Z'],
  ]);
  await updateIndex('t-label');
  const idx = await readFile(p.index, 'utf8');
  assert.match(idx, /확정\]\] — 확정 \(갱신 2026-07-20\)/);
  assert.match(idx, /추정\]\] — 추정 \(갱신 \d{4}-\d{2}-\d{2} 추정\)/);
});

test('일지 줄에는 갱신 표기가 붙지 않는다 (map 인덱스가 날짜 자리에 새는 회귀 가드)', async () => {
  const p = await seed('t-journal', []);
  // 날짜는 **오늘 기준 상대값**이어야 한다 — 인덱스가 최근 14일만 싣는데(memory.mjs cutoff)
  // 고정 날짜를 쓰면 그 날짜가 창 밖으로 밀리는 날 자정에 CI가 깨진다(2026-08-08 실제 발생:
  // 07-24 하드코딩이 컷오프 밖으로 나가 3→2건. 제품 로직은 정상, 테스트가 시한폭탄이었다).
  const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
  for (const n of [`${day(1)}-시원.md`, `${day(2)}-시원.md`, `${day(3)}-시원.md`]) {
    await writeFile(join(p.journal, n), `# ${n}\n\n기록.\n`);
  }
  await updateIndex('t-journal');
  const idx = await readFile(p.index, 'utf8');
  const journalLines = idx.split('\n').filter((l) => l.includes('[[journal/'));
  assert.equal(journalLines.length, 3);
  for (const l of journalLines) assert.doesNotMatch(l, /\(갱신/, `일지 줄에 갱신 표기가 샜다: ${l}`);
});

// sync.mjs가 텍스트 충돌 시 `<슬러그>.conflict-<기기>-<ts>.md`로 로컬본을 보존하는데, 그 파일은
// mtime이 '지금'이라 내용이 옛 판이어도 최신인 척 주제 노트 최상단을 차지한다(검수 MEDIUM).
test('동기화 충돌 사본은 주제 노트를 밀어내지 않고 별도 섹션으로 빠진다', async () => {
  const p = await seed('t-conflict', [
    ['배포-절차.md', '---\nupdated: 2026-07-20\n---\n# 배포 절차\n\n진짜 최신.\n'],
    ['옛-메모.md', '# 옛 메모\n\n3월 내용.\n', '2026-03-01T00:00:00Z'],
    ['옛-메모.conflict-devA-1753500000000.md', '# 옛 메모\n\n3월 내용(갈라진 사본).\n'], // mtime = 지금
  ]);
  await updateIndex('t-conflict');
  const idx = await readFile(p.index, 'utf8');
  const notesSection = idx.split('## 최근 일지')[0];
  assert.doesNotMatch(notesSection, /conflict-devA/, '충돌 사본이 주제 노트 구간에 남아 최상단을 차지한다');
  const order = [...notesSection.matchAll(/- \[\[notes\/(.+?)\]\]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['배포-절차', '옛-메모']);
  assert.match(idx, /## 동기화 충돌 사본[^\n]*\n- \[\[notes\/옛-메모\.conflict-devA-1753500000000\]\]/, '충돌 사본이 사라졌다 — 기억 유실');
});

test('역링크가 붙어도 노트의 mtime은 보존된다 — 링크는 내용 갱신이 아니다', async () => {
  const old = '2026-02-01T00:00:00Z';
  const p = await seed('t-mtime', [
    ['기존-노트.md', '# 기존 노트\n\n크루가 손으로 쓴 배포 절차 지식이다. 태그 푸시 후 자동 발행된다.\n', old],
  ]);
  const { saveNote } = await import('../src/memory.mjs');
  // 유사 문서를 새로 저장하면 autoLink가 기존 노트에 역링크를 append한다
  await saveNote('t-mtime', '배포 절차 개정', '크루가 손으로 쓴 배포 절차 지식이다. 태그 푸시 후 자동 발행된다.', { create: true });
  const after = await stat(join(p.notes, '기존-노트.md'));
  assert.equal(Math.round(after.mtimeMs), Date.parse(old), 'appendLink가 mtime을 올렸다 — 인덱스 순서가 오염된다');
});
