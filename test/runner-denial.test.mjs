// 러너 독립성 가드 — 실사용 신고 2026-07-26: "권한을 다 켜놨는데도 쓰기 권한이 차단이라고 뜨는데".
// 실측 캡처 2건(codex-cli 0.144.1)이 이 테스트의 근거다:
//  ① "reply with the exact error" 지시 → 생 에러 그대로: zsh:1: operation not permitted: /path
//  ② 한국어 크루형 지시 → 생 에러 없이 서술만: "…현재는 지정한 Desktop 경로에 쓰기 권한이 없습니다."
// 검수 1R(오탐 5건)·2R(들여쓴 코드블록·한글 접두·C:/ 드라이브 유실·펜스 토글) 경계를 전부 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectRunnerDenial, detectDeniedNarration, denialNote } from '../src/runner-denial.mjs';

test('실측 ①: codex 샌드박스 생 에러를 fs 거부로 인식한다', () => {
  const real = 'zsh:1: operation not permitted: /Users/yoogeon/argo-captest-off.txt';
  const d = detectRunnerDenial(real);
  assert.equal(d?.cap, 'fs');
  assert.equal(d.path, '/Users/yoogeon/argo-captest-off.txt');
  assert.equal(detectRunnerDenial(`쓰기를 시도했지만 실패했습니다.\n${real}`)?.cap, 'fs'); // 답변 중간 줄
});

test('실측 ②: 서술형 거부("쓰기 권한이 없습니다")를 narration으로 인식한다', () => {
  const real = '오늘 회의 내용이 제공되지 않아 요약을 작성할 수 없습니다. 또한 현재는 지정한 Desktop 경로에 쓰기 권한이 없습니다.\n\n회의록이나 핵심 메모를 보내주시면 요약한 뒤, 접근 가능한 작업공간의 `argo-cap2-report.md`로 저장해 드리겠습니다.';
  assert.equal(detectRunnerDenial(real), null, '생 에러가 없으니 strict는 null이어야 한다');
  assert.deepEqual(detectDeniedNarration(real)?.caps, ['fs']);
});

test('서술형: 네트워크 차단 서술은 browser, 평범한 답변은 null', () => {
  assert.deepEqual(detectDeniedNarration('웹 검색을 할 수 없어 최신 정보를 확인하지 못했습니다.')?.caps, ['browser']);
  assert.deepEqual(detectDeniedNarration('네트워크가 차단되어 있어 조회가 불가합니다.')?.caps, ['browser']);
  for (const s of ['보고서를 vault/notes에 저장했습니다.', '권한 관리 기능을 설명드리겠습니다.', '']) {
    assert.equal(detectDeniedNarration(s), null, s);
  }
});

test('서술형 3R: 네트워크 거부 인용("not permitted")이 fs로 오분류되지 않는다 — browser 우선', () => {
  // 3R MEDIUM 시나리오: codex가 network 차단을 "not permitted"로 뱉고 크루가 그대로 옮긴 답변
  const s = '네트워크 접근이 막혀 검색을 못 했습니다. codex가 "network access is not permitted"라고 응답했습니다.';
  assert.deepEqual(detectDeniedNarration(s)?.caps, ['browser'], 'fs 카드가 나가면 켜도 안 풀린다 — 신고 재생산');
  // fs·browser 둘 다 서술되면 browser가 앞 — 호출부가 OFF인 첫 능력을 채택한다(fs ON이 browser를 삼키지 않게)
  const both = '웹 검색을 할 수 없어 자료를 못 모았고, 결과를 저장하려 했지만 쓰기 권한이 없습니다.';
  assert.deepEqual(detectDeniedNarration(both)?.caps, ['browser', 'fs']);
});

test('서술형 3R: 인용·설명·성공 보고는 narration도 null이어야 한다 (오탐 코퍼스 결합 단언)', () => {
  for (const s of [
    // 1R strict 오탐 코퍼스 — bare "not permitted"/"permission denied"는 서술 정규식에 없어야 통과한다
    '아까 나온 zsh:1: operation not permitted: /Users/kim/a.txt 는 샌드박스가 막은 것입니다.',
    "로그를 보니 EACCES: permission denied, open '/var/log/app.log' 가 12회 있습니다.",
    '권한이 없으면 permission denied: /etc/nginx/nginx.conf 가 뜹니다. sudo를 쓰세요.',
    'USB가 /Volumes/USB/x.txt: Read-only file system 로 나오면 잠금 스위치를 확인하세요.',
    // 3R 실측 오탐 — 엔지니어링 크루의 일상 설명
    'S3 permission denied가 나오는 이유는 IAM 정책입니다.',
    // 펜스 안 옛 로그 인용 + 성공 보고
    '작업을 완료했습니다.\n```\n2026-07-20 zsh:1: operation not permitted: /old/log\n```\n이번에는 문제 없이 저장됐습니다.',
  ]) assert.equal(detectDeniedNarration(s), null, s);
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

test('서술형 유래(narrated)는 단정 대신 헤지 문구', () => {
  const note = denialNote({ cap: 'fs', capOn: false, lang: 'ko', narrated: true });
  assert.match(note, /보입니다/); // "막힌 것으로 보입니다" — 서술 추정임을 드러낸다
  const strict = denialNote({ cap: 'fs', capOn: false, lang: 'ko' });
  assert.match(strict, /막혔습니다/); // 생 에러 유래는 단정 유지
});

test('카드 생성 실패 시 설정 경로 폴백 안내 (검수 LOW-2)', () => {
  const note = denialNote({ cap: 'fs', capOn: false, lang: 'ko', cardShown: false });
  assert.match(note, /설정 → 로컬 능력/);
  assert.doesNotMatch(note, /카드를 띄웠습니다/);
});

test('능력 켜짐인데도 차단 → 단정하지 않고 원인 후보 나열 (검수 MEDIUM-3)', () => {
  const note = denialNote({ cap: 'fs', path: '/Users/kim/Documents/a.txt', capOn: true, lang: 'ko', outsideHome: false });
  assert.match(note, /이미 켜져 있는데도/);
  assert.match(note, /다음 중 하나일 수 있습니다/);
  assert.match(note, /시스템 설정/); // 후보 ① OS 권한
  assert.match(note, /AI 연결/);     // 후보 ② codex 연결 미반영(실사용 전례 2026-07-22)
  assert.doesNotMatch(note, /카드/);
});

test('영어 모드 안내가 전부 영어다', () => {
  for (const args of [
    { cap: 'fs', capOn: false }, { cap: 'fs', capOn: false, outsideHome: true, path: '/x/a' },
    { cap: 'fs', capOn: true }, { cap: 'browser', capOn: true },
    { cap: 'fs', capOn: false, cardShown: false }, { cap: 'browser', capOn: false, narrated: true },
  ]) {
    const s = denialNote({ ...args, lang: 'en' });
    assert.doesNotMatch(s, /[가-힣]/, JSON.stringify(args));
  }
});

// ── 배선 트립와이어 (검수 MEDIUM-4, 2R에서 강화) — 부품이 아니라 배선의 판단을 잠근다.
// chat() 전체를 단위로 태울 수 없어(러너·워크스페이스 필요) 소스 스캔으로 잠근다.
// 선례: test/no-hardcoded-runner-label.test.mjs
test('배선: chat.mjs 거부 블록이 감지→능력 게이트→카드 억제→안내를 전부 태운다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /detectRunnerDenial\(reply\)/, 'strict 감지가 러너 답변에 걸려 있어야 한다');
  const block = src.split('detectRunnerDenial(reply)')[1]?.slice(0, 2500) ?? '';
  assert.match(block, /detectDeniedNarration\(reply\)/, '서술형 2차 패스가 있어야 한다(실측 캡처 ②)');
  assert.match(block, /caps\.find\(\(c\) => !cliCaps\[c\]\)/, '서술형은 후보 중 OFF인 첫 능력만 채택 — 능력 ON 오정보 방지 + 켜진 후보가 꺼진 후보를 삼키지 않게(3R)');
  assert.match(block, /wantCard = !capOn && !\(denial\.cap === 'fs' && outsideHome\)/, 'fs OFF+홈 밖 카드 억제(HIGH-1)');
  assert.match(block, /cardShown: !!card/, '카드 생성 실패 폴백(LOW-2)이 배선돼 있어야 한다');
  assert.match(block, /suggestCapability\(/, '능력 OFF면 SDK와 같은 카드를 올려야 한다');
  assert.match(block, /denialNote\(/, '안내문이 답변에 덧붙어야 한다');
  assert.match(src, /runner === 'codex'[\s\S]{0,600}detectRunnerDenial/, 'codex 한정이어야 한다(gemini는 샌드박스 없음)');
  // Windows CI 트립와이어(v0.1.30 실측): chat.mjs에서 node:os 홈 함수를 부르면 Next 파일
  // 추적기(nft)가 빌드타임 실평가로 홈 전체를 글롭 → CI 러너 홈의 보호 항목에서 next build가
  // 죽는다. 홈은 env(HOME/USERPROFILE)로만 얻는다 — 이분법 5런(win-debug)으로 확정한 불변식.
  assert.doesNotMatch(src, /homedir/, 'chat.mjs에 homedir 금지 — nft 홈 글롭으로 Windows 빌드가 깨진다');
});
