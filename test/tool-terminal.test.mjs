// 도구 패널 터미널 — 셸 상태 유지, 출력 정리, 환경 시크릿 제거와 세션 종료.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = await mkdtemp(join(tmpdir(), 'argo-tool-terminal-'));
await mkdir(join(cwd, 'nested'));
const {
  cleanTerminalOutput,
  closeToolTerminal,
  readToolTerminal,
  startToolTerminal,
  toolTerminalCount,
  writeToolTerminal,
} = await import('../src/tool-terminal.mjs');

const open = new Set();
after(async () => {
  for (const id of open) {
    try { closeToolTerminal({ wsId: 'terminal-company', id }); } catch { /* 이미 종료 */ }
  }
  await rm(cwd, { recursive: true, force: true });
});

async function waitFor(id, pattern, cursor = 0) {
  let output = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const next = readToolTerminal({ wsId: 'terminal-company', id, cursor });
    output += next.output;
    cursor = next.cursor;
    if (pattern.test(output)) return { output, cursor };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`터미널 출력 대기 시간 초과: ${output}`);
}

test('ANSI/OSC 화면 제어를 걷고 사람이 읽는 텍스트는 보존한다', () => {
  assert.equal(cleanTerminalOutput('\u001b[31mred\u001b[0m\r\nnext'), 'red\nnext');
  assert.equal(cleanTerminalOutput('\u001b]0;secret\u0007title'), 'title');
});

test('같은 셸에서 cd 상태와 일반 명령 출력이 이어진다', async () => {
  const session = startToolTerminal({ wsId: 'terminal-company', cwd });
  open.add(session.id);
  const expected = join(cwd, 'nested');
  const expectedPattern = new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  writeToolTerminal({
    wsId: 'terminal-company',
    id: session.id,
    input: process.platform === 'win32' ? 'cd nested && cd' : 'cd nested && pwd',
  });
  const first = await waitFor(session.id, expectedPattern);
  writeToolTerminal({ wsId: 'terminal-company', id: session.id, input: 'printf "state-ok\\n"' });
  const second = await waitFor(session.id, /state-ok/, first.cursor);
  assert.match(first.output, /nested/);
  assert.match(second.output, /state-ok/);
  assert.equal(toolTerminalCount() >= 1, true);
  closeToolTerminal({ wsId: 'terminal-company', id: session.id });
  open.delete(session.id);
  assert.throws(
    () => readToolTerminal({ wsId: 'terminal-company', id: session.id }),
    (error) => error.code === 'terminal-not-found',
  );
});

test('모델 키와 Argo 서버 환경은 셸에 전달하지 않는다', async () => {
  const session = startToolTerminal({
    wsId: 'terminal-company',
    cwd,
    env: {
      ...process.env,
      SHELL: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh',
      OPENAI_API_KEY: 'model-secret',
      ARGO_TEST_SECRET: 'server-secret',
      SAFE_VISIBLE: 'safe-value',
    },
  });
  open.add(session.id);
  const command = process.platform === 'win32'
    ? 'echo %OPENAI_API_KEY%^|%ARGO_TEST_SECRET%^|%SAFE_VISIBLE%'
    : 'printf "%s|%s|%s\\n" "$OPENAI_API_KEY" "$ARGO_TEST_SECRET" "$SAFE_VISIBLE"';
  writeToolTerminal({ wsId: 'terminal-company', id: session.id, input: command });
  const result = await waitFor(session.id, /\|\|safe-value/);
  assert.doesNotMatch(result.output, /model-secret|server-secret/);
  closeToolTerminal({ wsId: 'terminal-company', id: session.id });
  open.delete(session.id);
});
