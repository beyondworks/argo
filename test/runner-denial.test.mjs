// 러너 독립성 가드 — 실사용 신고 2026-07-26: "권한을 다 켜놨는데도 쓰기 권한이 차단이라고 뜨는데".
// 재현(codex-cli 0.144.1): 능력 OFF면 크루 답변에 아래 생 셸 에러만 나오고
// SDK 러너와 달리 "켤까요?" 카드도, 능력 안내도 없었다.
//   zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt
// 검수(2026-07-26) 반영: 오탐(인용 답변) 실측 5건 → 줄 머리 앵커 + 코드펜스 제외,
// HIGH-1(fs OFF+홈 밖에 카드 약속 금지), MEDIUM-3(켜짐 분기 단정 금지) 경계를 여기서 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectRunnerDenial, denialNote } from '../src/runner-denial.mjs';

test('codex 샌드박스 거부(실측 문자열)를 fs 능력 거부로 인식한다', () => {
  const real = 'zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt';
  const d = detectRunnerDenial(real);
  assert.equal(d?.cap, 'fs');
  assert.equal(d.path, '/Users/yoogeon/argo-captest-off.txt');
  // 답변 중간에 생 출력 줄로 들어와도 잡는다(줄 단위 매칭)
  assert.equal(detectRunnerDenial(`쓰기를 시도했지만 실패했습니다.\n${real}`)?.cap, 'fs');
});

test('EACCES·EPERM·읽기전용도 생 출력 줄 형태면 fs 거부로 인식한다', () => {
  for (const s of [
    "Error: EACCES: permission denied, open '/Users/kim/Documents/a.txt'",
    'EPERM: operation not permitted, mkdir /Users/kim/out',
    'cp: /Volumes/USB/x.txt: Read-only file system',
  ]) assert.equal(detectRunnerDenial(s)?.cap, 'fs', s);
});

test('윈도우 드라이브 경로도 인식한다 (검수 MEDIUM-1)', () => {
  const d = detectRunnerDenial("EPERM: operation not permitted, open 'C:\\Users\\kim\\a.txt'");
  assert.equal(d?.cap, 'fs');
  assert.match(d.path, /^C:\\Users\\kim/);
});

test('네트워크 차단(생 출력 줄)은 browser 거부로 인식한다', () => {
  assert.equal(detectRunnerDenial('curl: (6) Could not resolve host: example.com')?.cap, 'browser');
  assert.equal(detectRunnerDenial('Error: getaddrinfo ENOTFOUND api.example.com')?.cap, 'browser');
});

test('오탐 방지: 에러를 인용·설명하는 정상 답변은 거부로 오인하지 않는다 (검수 HIGH-2 실측 5건)', () => {
  for (const s of [
    '아까 나온 zsh:1: operation not permitted: /Users/kim/a.txt 는 샌드박스가 막은 것입니다.',
    "로그를 보니 EACCES: permission denied, open '/var/log/app.log' 가 12회 있습니다.",
    '권한이 없으면 permission denied: /etc/nginx/nginx.conf 가 뜹니다. sudo를 쓰세요.',
    '```\ncurl: (6) Could not resolve host: example.com\n```\n위는 DNS 실패 예시입니다.',
    'USB가 /Volumes/USB/x.txt: Read-only file system 로 나오면 잠금 스위치를 확인하세요.',
  ]) assert.equal(detectRunnerDenial(s), null, s);
});

test('오탐 방지: 정상 답변·빈 문자열은 null', () => {
  for (const s of ['보고서를 vault/notes에 저장했습니다.', '', 'permission 설정을 확인했습니다']) {
    assert.equal(detectRunnerDenial(s), null, s);
  }
});

test('경로 꼬리 문장부호를 떼어낸다 (검수 LOW-3)', () => {
  const d = detectRunnerDenial('zsh:1: operation not permitted: /Users/kim/a.txt.');
  assert.equal(d.path, '/Users/kim/a.txt');
});

test('능력 꺼짐 + 홈 안 → "켤까요? 카드" 안내', () => {
  const note = denialNote({ cap: 'fs', path: '/Users/kim/a.txt', capOn: false, lang: 'ko', outsideHome: false });
  assert.match(note, /파일 시스템/);
  assert.match(note, /카드/);
  assert.doesNotMatch(note, /시스템 설정/); // 토글이 원인인데 OS 설정으로 보내면 안 된다
});

test('능력 꺼짐 + 홈 밖 → 카드를 약속하지 않고 홈 안 이동 안내 (검수 HIGH-1)', () => {
  const note = denialNote({ cap: 'fs', path: '/Volumes/USB/a.txt', capOn: false, lang: 'ko', outsideHome: true });
  assert.match(note, /홈 폴더/);
  assert.doesNotMatch(note, /카드/); // 켜도 안 열리는 조합 — 승인 유도는 신고 문구 재생산
});

test('카드 생성 실패 시 설정 경로 폴백 안내 (검수 LOW-2)', () => {
  const note = denialNote({ cap: 'fs', capOn: false, lang: 'ko', cardShown: false });
  assert.match(note, /설정 → 로컬 능력/);
  assert.doesNotMatch(note, /카드를 띄웠습니다/);
});

test('능력 켜짐인데도 차단 → 단정하지 않고 원인 후보 나열 (검수 MEDIUM-3)', () => {
  const note = denialNote({ cap: 'fs', path: '/Users/kim/Documents/a.txt', capOn: true, lang: 'ko', outsideHome: false });
  assert.match(note, /이미 켜져 있는데도/);
  assert.match(note, /다음 중 하나일 수 있습니다/); // 단정 금지
  assert.match(note, /시스템 설정/);       // 후보 ① OS 권한
  assert.match(note, /AI 연결/);           // 후보 ② codex 연결 미반영(실사용 전례 2026-07-22)
  assert.doesNotMatch(note, /카드/);
});

test('영어 모드 안내가 전부 영어다', () => {
  for (const args of [
    { cap: 'fs', capOn: false }, { cap: 'fs', capOn: false, outsideHome: true, path: '/x/a' },
    { cap: 'fs', capOn: true }, { cap: 'browser', capOn: true }, { cap: 'fs', capOn: false, cardShown: false },
  ]) {
    const s = denialNote({ ...args, lang: 'en' });
    assert.doesNotMatch(s, /[가-힣]/, JSON.stringify(args));
  }
});

// ── 배선 트립와이어 (검수 MEDIUM-4) — 부품이 아니라 배선을 잠근다.
// chat() 전체를 단위로 태울 수 없어(러너·워크스페이스 필요) 소스 스캔으로 잠근다.
// 선례: test/no-hardcoded-runner-label.test.mjs
test('배선: chat.mjs 외부 러너 경로가 거부 감지→카드→안내를 실제로 태운다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /detectRunnerDenial\(reply\)/, '거부 감지가 러너 답변에 걸려 있어야 한다');
  // 감지 블록 안에서 카드(suggestCapability)와 안내(denialNote)가 함께 쓰여야 한다
  const block = src.split('detectRunnerDenial(reply)')[1]?.slice(0, 1200) ?? '';
  assert.match(block, /suggestCapability\(/, '능력 OFF면 SDK와 같은 카드를 올려야 한다');
  assert.match(block, /denialNote\(/, '안내문이 답변에 덧붙어야 한다');
  assert.match(src, /runner === 'codex'[\s\S]{0,200}detectRunnerDenial/, 'codex 한정이어야 한다(gemini는 샌드박스 없음 — 거짓 안내 방지)');
});
