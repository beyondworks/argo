// 러너 독립성 가드 — 실사용 신고 2026-07-26: "권한을 다 켜놨는데도 쓰기 권한이 차단이라고 뜨는데".
// 재현(codex-cli 0.144.1, --sandbox workspace-key): 능력 OFF면 크루 답변에 아래 생 셸 에러만 나오고
// SDK 러너와 달리 "켤까요?" 카드도, 능력 안내도 없었다.
//   zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt
// 이 테스트는 (a) 그 문자열을 능력 거부로 인식하는지 (b) 능력이 이미 켜진 경우와 안내가 갈리는지를 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRunnerDenial, denialNote } from '../src/runner-denial.mjs';

test('codex 샌드박스 거부(실측 문자열)를 fs 능력 거부로 인식한다', () => {
  const real = 'zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt';
  const d = detectRunnerDenial(real);
  assert.equal(d?.cap, 'fs');
  assert.equal(d.path, '/Users/yoogeon/argo-captest-off.txt');
});

test('EACCES·EPERM·읽기전용 파일시스템도 fs 거부로 인식한다', () => {
  for (const s of [
    "Error: EACCES: permission denied, open '/Users/kim/Documents/a.txt'",
    'EPERM: operation not permitted, mkdir /Users/kim/out',
    'cp: /Volumes/USB/x.txt: Read-only file system',
  ]) assert.equal(detectRunnerDenial(s)?.cap, 'fs', s);
});

test('네트워크 차단은 browser 거부로 인식한다', () => {
  assert.equal(detectRunnerDenial('curl: (6) Could not resolve host: example.com')?.cap, 'browser');
});

test('정상 답변은 거부로 오인하지 않는다', () => {
  for (const s of ['보고서를 vault/notes에 저장했습니다.', '', 'permission 설정을 확인했습니다']) {
    assert.equal(detectRunnerDenial(s), null, s);
  }
});

test('능력이 꺼져 있으면 "켤까요? 카드" 안내가 나간다', () => {
  const note = denialNote({ cap: 'fs', path: '/Users/kim/a.txt', capOn: false, lang: 'ko' });
  assert.match(note, /파일 시스템/);
  assert.match(note, /카드/);
  assert.doesNotMatch(note, /시스템 설정/); // 토글이 원인인데 OS 설정으로 보내면 안 된다
});

test('능력이 켜져 있는데도 막히면 남은 원인(OS 권한·홈 밖)을 짚는다', () => {
  const inHome = denialNote({ cap: 'fs', path: '/Users/kim/Documents/a.txt', capOn: true, lang: 'ko', outsideHome: false });
  assert.match(inHome, /이미 켜져 있는데도/);
  assert.match(inHome, /시스템 설정/); // "다 켰는데 왜 안 되냐"의 실제 답
  assert.doesNotMatch(inHome, /카드/); // 이미 켜져 있으니 카드를 또 띄우자고 하면 안 된다

  const outside = denialNote({ cap: 'fs', path: '/Volumes/USB/a.txt', capOn: true, lang: 'ko', outsideHome: true });
  assert.match(outside, /홈 폴더 밖/);
});

test('영어 모드에서도 두 갈래 안내가 모두 영어다', () => {
  const off = denialNote({ cap: 'fs', capOn: false, lang: 'en' });
  const on = denialNote({ cap: 'fs', capOn: true, lang: 'en', outsideHome: false });
  for (const s of [off, on]) assert.doesNotMatch(s, /[가-힣]/, s);
  assert.match(on, /System Settings|Full Disk Access/);
});
