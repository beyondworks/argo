// 러너 무관 산출물 수집(제보 2026-07-30: "만들었다는데 못 찾는다") — 파일시스템 diff가 정본.
// ① 행동: 실제 임시 vault에서 스냅샷→생성/수정→diff ② 필터: 서빙 가능한 것만(칩=서빙 일치)
// ③ 배선: chat() 두 반환부(SDK·CLI)와 appendTurn 호출부 7곳이 실제로 전파하는지(소스 트립와이어 —
//    순수 함수가 맞아도 호출부가 빠지면 칩은 안 뜬다. 선례: runner-neutrality 배선 단언).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotArtifacts, diffArtifacts, servableArtifact, capLatest, SERVE_PREFIXES } from '../src/artifacts.mjs';

test('snapshot→diff: 신규·수정 파일만 잡고, 도트·미변경·구역 밖은 제외', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'argo-art-'));
  await mkdir(join(vault, 'projects', '20260730_x'), { recursive: true });
  await mkdir(join(vault, 'files'), { recursive: true });
  await mkdir(join(vault, 'journal'), { recursive: true });
  await writeFile(join(vault, 'projects', '20260730_x', '기존.md'), 'v1');
  const before = await snapshotArtifacts(vault);

  await writeFile(join(vault, 'projects', '20260730_x', '제안서.pptx'), 'PPT'); // 신규(하위 폴더)
  await writeFile(join(vault, 'projects', '20260730_x', '기존.md'), 'v2-내용이-바뀜'); // 수정
  await writeFile(join(vault, 'files', '표.xlsx'), 'X'); // 신규(files)
  await writeFile(join(vault, 'projects', '.상태.json'), '{}'); // 도트 — 산출물 아님
  await writeFile(join(vault, 'journal', '2026-07-30-a.md'), 'j'); // 구역 밖(journal은 스캔 안 함)
  const after = await snapshotArtifacts(vault);

  assert.deepEqual(diffArtifacts(before, after), [
    'files/표.xlsx', 'projects/20260730_x/기존.md', 'projects/20260730_x/제안서.pptx',
  ]);
});

test('snapshot: 심링크는 따라가지 않는다(구역 밖 유출 방지)', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'argo-art-sym-'));
  const outside = await mkdtemp(join(tmpdir(), 'argo-art-out-'));
  await writeFile(join(outside, '비밀.txt'), 's');
  await mkdir(join(vault, 'projects'), { recursive: true });
  await symlink(outside, join(vault, 'projects', 'link')).catch(() => {}); // Windows 권한 실패 관용
  const snap = await snapshotArtifacts(vault);
  assert.equal([...snap.keys()].some((k) => k.includes('비밀')), false);
});

test('servableArtifact: 칩 허용 = 서빙 가능(G8 — 칩 뜨는데 400 나던 불일치 봉인)', () => {
  assert.equal(servableArtifact('projects/20260730_x/제안서.pptx'), true);
  assert.equal(servableArtifact('files/표.xlsx'), true);
  assert.equal(servableArtifact('_imported/노트.pdf'), true);
  assert.equal(servableArtifact('notes/데이터.csv'), false); // files API 밖 비md — 누르면 400이었다
  assert.equal(servableArtifact('보고서.xlsx'), false);      // vault 직속 비md — 동일
  assert.equal(servableArtifact('notes/메모.md'), true);      // md는 뷰어가 연다
  assert.equal(servableArtifact('journal/2026-07-30-a.md'), false); // 일지 — 전용 칩과 중복
  assert.equal(servableArtifact(''), false);
});

test('배선: 반환부·호출부 전파(행동 검증은 artifacts-behavior.test.mjs — 개수 단언 금지)', async () => {
  const chat = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  // 검수 CRITICAL-3 교훈: "diff 호출 개수" 단언은 위치를 못 보고, buggy 조합(예산 분기 오염 +
  // CLI 미수정)에서만 초록인 안티 게이트였다. 위치는 유니크 앵커로, 유효성은 행동 파일이 잠근다.
  assert.match(chat, /journalRel: relative\(p\.vault, handover\.file\),\n      \}\);\n      \/\/ 모델을 부르지 않은 턴/, '예산 분기는 diff 미참조(TDZ 회귀 금지)');
  assert.match(chat, /downgradedFrom: effModel \} : \{\}\) \}\);[\s\S]{0,400}?return \{ reply, sessionId: null, handover, artifacts: await artDiff\(\), \.\.\.fellBackInfo \};/, 'CLI 반환부가 diff를 싣는다(주석 줄수 무관 — 검수 LOW-5, fellBackInfo는 폴백 투명화 P2)');
  assert.match(chat, /source === 'compete' \? null/, '경쟁 턴은 diff 제외(합집합 오귀속 방지 — 검수 HIGH)');
  assert.match(chat, /via: 'delegate', artifacts: r\.artifacts/, '위임 미러 전파');
  assert.match(await readFile(new URL('../src/trial.mjs', import.meta.url), 'utf8'), /artifacts: r\.artifacts/, '시운전 전파(검수 HIGH)');
  const sites = [
    ['../src/scheduler.mjs', /via: 'crewmail', artifacts: t\.artifacts/],
    ['../src/routines.mjs', /via: 'routine', artifacts: t\.artifacts/],
    ['../src/gateway.mjs', /via: 'job', artifacts: t\.artifacts/],
    ['../src/gateway.mjs', /attachments, artifacts: turn\.artifacts/],
    ['../src/approval-actions.mjs', /sessionId: r\.sessionId, artifacts: r\.artifacts/],
    ['../src/compete.mjs', /artifacts: w\.artifacts/],
  ];
  for (const [p, re] of sites) {
    assert.match(await readFile(new URL(p, import.meta.url), 'utf8'), re, `전파 누락: ${p}`);
  }
  // 수집-서빙 접두 동일 목록 계약 — files API가 이 상수를 공유하지 않는 한 원문 대조로 잠근다.
  const filesApi = await readFile(new URL('../app/api/companies/[ws]/files/route.js', import.meta.url), 'utf8');
  for (const p of SERVE_PREFIXES) assert.ok(filesApi.includes(`'${p}'`), `files API 허용 접두 불일치: ${p}`);
});

test('servableArtifact 강화(검수 LOW): 케이스폴딩 journal·탈출·백슬래시 거부', () => {
  assert.equal(servableArtifact('JOURNAL/j.md'), false); // macOS 무시 FS 우회
  assert.equal(servableArtifact('Journal/j.md'), false);
  assert.equal(servableArtifact('projects/../../etc/passwd'), false);
  assert.equal(servableArtifact('files\\윈도.pdf'), false);
  assert.equal(servableArtifact('notes/메모.md'), true); // notes 스캔 합류(md만)
});

test('capLatest: 최신 우선 + 상한(복원·임포트 겹침 420칩 폭발 방어 — 검수 HIGH)', () => {
  const after = new Map([['projects/old.md', '100:1'], ['projects/new.md', '300:1'], ['files/mid.pdf', '200:1']]);
  assert.deepEqual(capLatest(after, ['projects/old.md', 'projects/new.md', 'files/mid.pdf'], 2),
    ['projects/new.md', 'files/mid.pdf']);
  const big = new Map(Array.from({ length: 50 }, (_, i) => [`projects/f${i}.md`, `${i}:1`]));
  assert.equal(capLatest(big, [...big.keys()]).length, 12);
});
