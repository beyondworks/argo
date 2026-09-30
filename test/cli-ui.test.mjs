// argo 대화 화면 — 유건 결정 2026-09-30: `argo`를 치면 심볼·ARGO 글자·버전이 뜨고 바로 대화(Claude Code 터미널처럼).
// 나가기는 /quit·/exit·exit·quit만 — Ctrl+C는 나가지 않는다(답하는 중이면 그 턴만 멈추고, 입력 중이면 줄을 지운다).
// 명령은 영어 /명령(한글 명령은 한영 전환이 번거롭다), 색은 graphite 흑백(굵게·흐리게만).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banner, parseInput, visibleWidth } from '../src/cli/ui.mjs';

test('나가기 — /quit·/exit·exit·quit(대소문자·앞뒤 공백 무관)만 종료로 읽는다', () => {
  for (const s of ['/quit', '/exit', 'exit', 'quit', '  EXIT ', '/Quit']) assert.deepEqual(parseInput(s), { kind: 'quit' }, s);
  // "exit"로 시작하는 문장은 크루에게 보내는 말이다 — 종료로 오인하면 대화가 끊긴다
  assert.deepEqual(parseInput('exit 조건을 정리해줘'), { kind: 'message', text: 'exit 조건을 정리해줘' });
});

test('명령·메시지·빈 줄 구분', () => {
  assert.deepEqual(parseInput('/crew pepper'), { kind: 'command', name: 'crew', arg: 'pepper' });
  assert.deepEqual(parseInput('/help'), { kind: 'command', name: 'help', arg: '' });
  assert.deepEqual(parseInput('/없는명령'), { kind: 'unknown', name: '없는명령' });
  assert.deepEqual(parseInput('이번 주 게시물 써줘'), { kind: 'message', text: '이번 주 게시물 써줘' });
  assert.deepEqual(parseInput('   '), { kind: 'empty' });
  // 경로처럼 /로 시작하는 문장은 크루에게 보내는 말이다(첫 단어에 /가 더 있으면 명령이 아니다)
  assert.deepEqual(parseInput('/Users/me/a.md 읽어줘'), { kind: 'message', text: '/Users/me/a.md 읽어줘' });
});

test('배너 — 넓은 터미널은 심볼 + ARGO 글자 + 버전, 어떤 줄도 터미널 폭을 넘지 않는다', () => {
  const lines = banner({ cols: 80, version: '0.1.90', color: false });
  assert.ok(lines.some((l) => l.includes('▀██▀')), '심볼(별 아래 끝)');
  assert.ok(lines.some((l) => l.includes('███████ ██████')), 'ARGO 큰 글자');
  assert.ok(lines.some((l) => l.includes('v0.1.90')));
  for (const l of lines) assert.ok(visibleWidth(l) <= 80, l);
});

test('배너 — 60칸 미만이면 큰 글자를 빼고 작은 한 줄로 줄인다, 색을 끄면 제어 문자가 없다', () => {
  const narrow = banner({ cols: 50, version: '0.1.90', color: false });
  assert.ok(!narrow.some((l) => l.includes('███████ ██████')));
  assert.ok(narrow.some((l) => /ARGO\s+v0\.1\.90/.test(l)));
  for (const l of narrow) assert.ok(visibleWidth(l) <= 50, l);
  const plain = banner({ cols: 80, version: '0.1.90', color: false }).join('\n');
  assert.equal(/\x1b\[/.test(plain), false);
  const colored = banner({ cols: 80, version: '0.1.90', color: true }).join('\n');
  assert.ok(/\x1b\[2m/.test(colored), '버전은 흐린 회색');
  assert.equal(/\x1b\[3[0-7]m|\x1b\[38;/.test(colored), false, '색상 코드 없음 — 흑백(graphite)');
});

test('진행 줄 폭 — 한글은 2칸으로 세어 터미널 한 줄을 넘기지 않는다(넘치면 \\r 덮어쓰기가 깨져 줄이 쌓인다)', async () => {
  const { termWidth, fit } = await import('../src/cli/ui.mjs');
  assert.equal(termWidth('페퍼 ab'), 7);
  const s = fit('노트 읽는 중 '.repeat(20), 40);
  assert.ok(termWidth(s) <= 40, `${termWidth(s)}`);
  assert.ok(s.endsWith('…'));
  assert.equal(fit('짧음', 40), '짧음');
});

test('CLI 안내 — 앱 기준 "설정 → AI 연결"은 /ai로, 코어 진단 로그([argo] …)는 대화 화면이 아닌 파일로', async () => {
  const { cliHintText, isCoreLog } = await import('../src/cli/ui.mjs');
  assert.equal(cliHintText('AI 러너가 하나도 연결돼 있지 않습니다. 설정 → AI 연결에서 Claude 중 하나를 연결한 뒤'), 'AI 러너가 하나도 연결돼 있지 않습니다. /ai에서 Claude 중 하나를 연결한 뒤');
  assert.equal(cliHintText('Connect one in Settings → AI connections (Claude)'), 'Connect one in /ai (Claude)');
  assert.equal(isCoreLog('[argo] 기기 간 동기화 시작 (8s 주기)'), true);
  assert.equal(isCoreLog('[sync] 안전하지 않은 키'), true);
  assert.equal(isCoreLog('  노바'), false);
  assert.equal(isCoreLog('[1] 목록 번호'), false, '숫자 대괄호는 사용자 문구일 수 있다');
  assert.equal(isCoreLog({}), false);
});
