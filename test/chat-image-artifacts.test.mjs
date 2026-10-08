// 대화창 그림(정비사 10/5 전달) — 칩·지시문 쪽. 격리 서버 재현(origin/main f19d2d21): 답이 기존 그림을 가리켜도 응답 artifacts: [],
// 본체 채팅 턴 시스템 프롬프트에 "그림은 vault 경로 마크다운 이미지로" 규칙 없음(메신저 턴에만). 그림 렌더·클릭은 chat-inline-images.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const AVATAR = 'projects/20261002_페퍼-아바타/페퍼-아바타.png';

// ─── 산출물 칩: 답이 가리킨 기존 파일(P2) — 이번 턴에 안 바뀐 파일도 답변이 경로로 가리키면 칩에 ───
const art = await import('../src/artifacts.mjs');
const snap = (...rels) => new Map(rels.map((r, i) => [r, `${1000 + i}:10`]));
const SNAP = snap(AVATAR, 'projects/x/report.md', 'files/표.xlsx', 'notes/outside.png', 'notes/메모.md', '_imported/a/b.pdf', 'projects/a/b.png', 'projects/a/b.png.bak');
const attrib = (changed, reply, opts = {}) => art.attributeArtifacts(changed, { entry: opts.entry ?? { observed: new Set() }, others: opts.others ?? [], reply, snapshot: SNAP });
test('칩: 답이 그림·링크·맨 경로로 가리킨 구역 안 기존 파일은 이번 턴에 안 바뀌어도 칩에 든다(제보 사례)', () => {
  assert.deepEqual(attrib([], `페퍼 아바타입니다.\n\n![페퍼](${AVATAR})`), [AVATAR], '그림 문법');
  assert.deepEqual(attrib([], `[보고서](projects/x/report.md)`), ['projects/x/report.md'], '링크 문법');
  assert.deepEqual(attrib([], `${AVATAR}에 저장돼 있습니다.`), [AVATAR], '맨 경로 + 한글 조사');
  assert.deepEqual(attrib([], `파일: vault/files/표.xlsx, 그리고 ./_imported/a/b.pdf.`), ['_imported/a/b.pdf', 'files/표.xlsx'], 'vault/·./ 접두, 문장 부호');
  assert.deepEqual(attrib([], `![a](${encodeURI(AVATAR)})`), [AVATAR], '%인코딩 목적지');
  assert.deepEqual(attrib(['projects/new.md'], `새 문서와 ![a](${AVATAR})`), ['projects/new.md', AVATAR], '이번 턴 변경분과 합집합');
});
test('칩: 구역 밖(notes)·없는 파일·탈출·이름만·경로 일부만은 칩에 안 든다', () => {
  assert.deepEqual(attrib([], '![x](notes/outside.png) [m](notes/메모.md) notes/메모.md'), [], 'notes는 근거 인용 자리 — 칩 아님');
  assert.deepEqual(attrib([], '![x](projects/x/없는그림.png) projects/x/없는파일.pdf'), [], '스냅샷에 없는 파일');
  assert.deepEqual(attrib([], '![x](projects/x/../x/report.md) projects/%2e%2e/x/report.md'), [], '탈출 표기');
  assert.deepEqual(attrib([], 'report.md를 참고하세요'), [], '이름만');
  assert.deepEqual(attrib([], '백업은 projects/a/b.png.bak 입니다'), ['projects/a/b.png.bak'], '긴 이름의 앞부분(b.png)은 잡지 않는다');
  assert.deepEqual(attrib([], 'myprojects/a/b.png'), [], '경로 앞 경계');
});
test('칩: 겹친 다른 턴이 도구로 쓴 파일은 답이 가리켜도 빠진다(오귀속 겹침 검사 유지 — 제보 2026-09-15)', () => {
  const other = { observed: new Set([AVATAR]) };
  assert.deepEqual(attrib([AVATAR], `![a](${AVATAR})`, { others: [other] }), []);
  assert.deepEqual(attrib([], `![a](${AVATAR}) [r](projects/x/report.md)`, { others: [other] }), ['projects/x/report.md']);
  assert.deepEqual(art.attributeArtifacts(['projects/a.md'], { entry: { observed: new Set() }, others: [], reply: `![a](${AVATAR})` }), ['projects/a.md'], '스냅샷을 안 주면 종전 동작');
});
test('칩(행동): 임시 vault — 턴 전후 스냅샷이 같아도(안 바뀐 기존 그림) 답이 가리키면 칩', async () => {
  const { mkdtemp } = await import('./helpers/tmp.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const vault = await mkdtemp(join(tmpdir(), 'argo-imgref-'));
  await mkdir(join(vault, 'projects', '20261002_페퍼-아바타'), { recursive: true });
  await writeFile(join(vault, 'projects', '20261002_페퍼-아바타', '페퍼-아바타.png'), 'png');
  const before = await art.snapshotArtifacts(vault);
  const after = await art.snapshotArtifacts(vault);
  const changed = art.diffArtifacts(before, after).filter(art.servableArtifact);
  assert.deepEqual(changed, [], '이번 턴 변경 없음');
  assert.deepEqual(art.capLatest(after, art.attributeArtifacts(changed, { entry: null, others: [], reply: `![페퍼](${AVATAR})`, snapshot: after })), [AVATAR]);
});

// ─── 크루 지시문(P3): 본체 채팅 턴에도 "그림은 vault 경로 마크다운 이미지로" — 메신저 턴에만 있던 안내 ───
test('지시문: ko·en 시스템 프롬프트에 그림 표시 규칙(구역 안 저장 + 마크다운 이미지 + 줄 없이 "표시했다" 금지)', async () => {
  const { mkdtemp } = await import('./helpers/tmp.mjs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.ARGO_ROOT ??= await mkdtemp(join(tmpdir(), 'argo-imgsp-'));
  const { systemPromptFor } = await import('../src/chat.mjs');
  const ko = systemPromptFor('---\nname: 페퍼\n---\n# 페퍼', '/ws', '', { name: '페퍼' }, 'ko');
  const en = systemPromptFor('---\nname: Pepper\n---\n# Pepper', '/ws', '', { name: 'Pepper' }, 'en');
  const sect = (p, head) => p.split(head)[1]?.split('\n## ')[0] ?? '';
  const k = sect(ko, '## 파일·산출물'); const e = sect(en, '## Files & deliverables');
  assert.match(k, /마크다운 이미지/); assert.match(k, /!\[[^\]]*\]\(projects\/[^)]+\.png\)/); assert.match(k, /vault\/projects\/·vault\/files\/·vault\/_imported\//); assert.match(k, /표시했다/);
  assert.match(e, /markdown image/); assert.match(e, /!\[[^\]]*\]\(projects\/[^)]+\.png\)/); assert.match(e, /vault\/projects\/, vault\/files\/ or vault\/_imported\//); assert.match(e, /Never say you displayed/);
  for (const off of [systemPromptFor('# x', '/ws', '', {}, 'ko', { hasTools: false }), systemPromptFor('# x', '/ws', '', {}, 'en', { hasTools: false })]) assert.match(off, /!\[[^\]]*\]\(projects\//, 'CLI 러너(도구 없음) 골격에도 같은 규칙');
});
