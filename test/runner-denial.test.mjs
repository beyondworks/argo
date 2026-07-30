// 러너 독립성 가드 — 실사용 신고 2026-07-26: "권한을 다 켜놨는데도 쓰기 권한이 차단이라고 뜨는데".
// 실측 캡처(codex-cli 0.144.1): "reply with the exact error" 지시 → 생 에러 그대로:
//   zsh:1: operation not permitted: /path
// 검수 1R(오탐 5건)·2R(들여쓴 코드블록·한글 접두·C:/ 드라이브 유실·펜스 토글) 경계를 전부 잠근다.
// 서술형 2차 탐지(detectDeniedNarration)와 능력 OFF·켜기 카드 갈래는 전권 전환(2026-07-30)으로
// 도달 불가가 되어 제거 — 죽은 배선을 소스 단언이 고정하던 것을 분리 검수가 잡았다(그 반대 방향,
// 즉 죽은 배선의 재유입을 아래 배선 테스트가 잠근다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectRunnerDenial, denialNote } from '../src/runner-denial.mjs';

test('실측: codex 샌드박스 생 에러를 fs 거부로 인식한다', () => {
  const real = 'zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt';
  const d = detectRunnerDenial(real);
  assert.equal(d?.cap, 'fs');
  assert.equal(d.path, '/Users/yoogeon/argo-captest-off.txt');
  assert.equal(detectRunnerDenial(`쓰기를 시도했지만 실패했습니다.\n${real}`)?.cap, 'fs'); // 답변 중간 줄
});

test('서술형("쓰기 권한이 없습니다")은 strict가 잡지 않는다 — 안내 없음이 의도(전권 전환의 수용 트레이드)', () => {
  // 이전엔 능력 OFF일 때만 서술 탐지로 켜기 카드를 이었다. 전권에선 그 갈래가 없고,
  // 홈+작업 폴더가 기본 쓰기 범위라 이 서술 자체가 대부분 사라진다(Desktop은 이제 쓰기 가능).
  const real = '오늘 회의 내용이 제공되지 않아 요약을 작성할 수 없습니다. 또한 현재는 지정한 Desktop 경로에 쓰기 권한이 없습니다.';
  assert.equal(detectRunnerDenial(real), null, '생 에러가 없으니 strict는 null');
});

test('EACCES(콜론 필수)·EPERM·읽기전용 생 출력 줄을 인식한다', () => {
  for (const s of [
    "Error: EACCES: permission denied, open '/Users/kim/Documents/a.txt'",
    'EPERM: operation not permitted, mkdir /Users/kim/out',
    'cp: /Volumes/USB/x.txt: Read-only file system',
  ]) assert.equal(detectRunnerDenial(s)?.cap, 'fs', s);
});

test('윈도우 경로: 역슬래시·슬래시 모두 드라이브를 보존한다 (검수 2R MEDIUM-2)', () => {
  const bs = detectRunnerDenial("EPERM: operation not permitted, open 'C:\\Users\\kim\\a.txt'");
  assert.match(bs?.path ?? '', /^C:\\Users\\kim/);
  const fs2 = detectRunnerDenial("Error: EACCES: permission denied, open 'C:/Users/kim/a.txt'");
  assert.match(fs2?.path ?? '', /^C:\/Users\/kim/, '슬래시형에서 드라이브가 잘리면 홈 판정이 뒤집힌다');
});

test('네트워크 생 에러는 browser — 점 있는 호스트·비한글 줄만', () => {
  assert.equal(detectRunnerDenial('curl: (6) Could not resolve host: example.com')?.cap, 'browser');
  assert.equal(detectRunnerDenial('Error: getaddrinfo ENOTFOUND api.example.com')?.cap, 'browser');
});

test('오탐 방지 1R: 에러를 인용·설명하는 정상 답변 5건 (실측)', () => {
  for (const s of [
    '아까 나온 zsh:1: operation not permitted: /Users/kim/a.txt 는 샌드박스가 막은 것입니다.',
    "로그를 보니 EACCES: permission denied, open '/var/log/app.log' 가 12회 있습니다.",
    '권한이 없으면 permission denied: /etc/nginx/nginx.conf 가 뜹니다. sudo를 쓰세요.',
    '```\ncurl: (6) Could not resolve host: example.com\n```\n위는 DNS 실패 예시입니다.',
    'USB가 /Volumes/USB/x.txt: Read-only file system 로 나오면 잠금 스위치를 확인하세요.',
  ]) assert.equal(detectRunnerDenial(s), null, s);
});

test('오탐 방지 2R: 한글 접두·설명문·들여쓴 코드블록·한글 네트워크 문장 (실측 오탐 재발 방지)', () => {
  for (const s of [
    '참고: permission denied: /etc/hosts 는 루트 파일입니다.',
    '주의: EACCES: permission denied, open /Users/kim/a.txt 가 날 수 있습니다.', // 한글 접두 차단
    'EACCES 오류는 권한 문제입니다. 보통 /Users/kim/a.txt 같은 경로에서 납니다.', // 콜론 없음
    'ENOTFOUND는 DNS가 이름을 못 찾았다는 뜻입니다.',
    'Network is unreachable 메시지가 보이면 VPN을 확인하세요.', // 한글 포함 줄 가드
    '    zsh:1: operation not permitted: /Users/kim/a.txt', // 4칸 들여쓰기 = 코드블록
    '\tzsh:1: operation not permitted: /Users/kim/a.txt', // 탭 들여쓰기
  ]) assert.equal(detectRunnerDenial(s), null, s);
});

test('펜스 추적: 종류·길이 매칭 — 4중 백틱 안 3중 백틱이 토글을 뒤집지 않는다 (검수 2R LOW-2)', () => {
  const quad = '````\n```\nzsh:1: operation not permitted: /Users/kim/a.txt\n```\n````\n예시였습니다.';
  assert.equal(detectRunnerDenial(quad), null);
  const mixed = '```\n예시 블록\n~~~\nzsh:1: operation not permitted: /Users/kim/a.txt\n~~~ 이 줄은 아직 ``` 안이다';
  assert.equal(detectRunnerDenial(mixed), null);
});

test('경로 꼬리 문장부호를 떼어낸다 (검수 LOW-3)', () => {
  assert.equal(detectRunnerDenial('zsh:1: operation not permitted: /Users/kim/a.txt.')?.path, '/Users/kim/a.txt');
});

/* ── denialNote(전권 계약) — 원인을 능력이 아니라 샌드박스 범위·OS·네트워크 후보로 안내한다 ── */

test('fs + 홈·작업 폴더 밖 → 작업 폴더 등록/홈 이동 안내(능력 문구 금지)', () => {
  const note = denialNote({ cap: 'fs', path: '/Volumes/USB/a.txt', lang: 'ko', outsideHome: true });
  assert.match(note, /작업 폴더/); // 전권의 실제 해법 — 설정 → 작업 폴더 등록
  assert.doesNotMatch(note, /능력/, '능력 토글은 사라졌다 — 언급하면 사장이 없는 메뉴를 찾는다');
  assert.doesNotMatch(note, /카드/);
});

test('fs + 범위 안(또는 판정 불가) → OS 권한·러너 재연결 후보 나열(단정 금지)', () => {
  const note = denialNote({ cap: 'fs', path: '/Users/kim/Documents/a.txt', lang: 'ko', outsideHome: false });
  assert.match(note, /다음 중 하나일 수 있습니다/);
  assert.match(note, /시스템 설정/); // 후보 ① OS 권한(TCC)
  assert.match(note, /AI 연결/);     // 후보 ② codex 연결 미반영(실사용 전례 2026-07-22)
  assert.doesNotMatch(note, /능력/);
});

test('browser → 네트워크·러너 재연결 후보(능력 문구 금지)', () => {
  const note = denialNote({ cap: 'browser', lang: 'ko' });
  assert.match(note, /네트워크가 막혔습니다/);
  assert.doesNotMatch(note, /능력/);
});

test('영어 모드 안내가 전부 영어다', () => {
  for (const args of [
    { cap: 'fs' }, { cap: 'fs', outsideHome: true, path: '/x/a' }, { cap: 'browser' },
  ]) {
    const s = denialNote({ ...args, lang: 'en' });
    assert.doesNotMatch(s, /[가-힣]/, JSON.stringify(args));
  }
});

// ── 배선 트립와이어 — 부품이 아니라 배선의 판단을 잠근다. chat() 전체를 단위로 태울 수 없어
// (러너·워크스페이스 필요) 소스 스캔으로 잠근다. 선례: test/no-hardcoded-runner-label.test.mjs
test('배선: chat.mjs 거부 블록 = strict 탐지 → denialNote, codex 한정 + 죽은 배선 재유입 금지', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /detectRunnerDenial\(reply\)/, 'strict 감지가 러너 답변에 걸려 있어야 한다');
  const block = src.split('detectRunnerDenial(reply)')[1]?.slice(0, 1800) ?? '';
  assert.match(block, /denialNote\(/, '안내문이 답변에 덧붙어야 한다');
  assert.match(src, /runner === 'codex'[\s\S]{0,600}detectRunnerDenial/, 'codex 한정이어야 한다(gemini는 샌드박스 없음)');
  // 죽은 배선 재유입 금지(분리 검수 2026-07-30) — 전권에서 능력 OFF 갈래는 도달 불가다.
  // 이 단언들은 실제로 되돌려(임포트 복원) 빨간불을 확인했다.
  assert.doesNotMatch(src, /detectDeniedNarration/, '서술형 탐지 배선은 걷어냈다 — 되살리려면 전권 모델과의 정합부터 설계할 것');
  assert.doesNotMatch(src, /suggestCapability/, '능력 켜기 카드는 전권 전환으로 제거됐다');
  // Windows CI 트립와이어(v0.1.30 실측): chat.mjs에서 node:os 홈 함수를 부르면 Next 파일
  // 추적기(nft)가 빌드타임 실평가로 홈 전체를 글롭 → CI 러너 홈의 보호 항목에서 next build가
  // 죽는다. 홈은 env(HOME/USERPROFILE)로만 얻는다 — 이분법 5런(win-debug)으로 확정한 불변식.
  assert.doesNotMatch(src, /homedir/, 'chat.mjs에 homedir 금지 — nft 홈 글롭으로 Windows 빌드가 깨진다');
});
