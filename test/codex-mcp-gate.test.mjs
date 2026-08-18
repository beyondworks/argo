// codex MCP 주입 게이트 — 실행 불가한 command를 config.toml에 실으면 codex 기동이 실패해
// **턴 전체가 죽는다**(주입 도입 전엔 없던 실패 모드, 자가 발견 2026-08-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandExists, writeCodexTurnConfig } from '../src/runners/codex.mjs';

test('commandExists: PATH·절대경로·부재를 가른다', () => {
  assert.equal(commandExists(process.execPath), true, '절대 경로 실재');
  assert.equal(commandExists('argo-definitely-missing-xyz'), false, '부재');
  assert.equal(commandExists(''), false);
  assert.equal(commandExists(null), false);
});

test('깨진 MCP는 config.toml에서 빠지고, 멀쩡한 것만 실린다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-codexcfg-'));
  await writeCodexTurnConfig(home, {}, [], {
    good: { command: process.execPath, args: ['-e', 'null'] },
    broken: { command: 'argo-definitely-missing-xyz', args: [] },
    remote: { url: 'https://example.com/mcp' },
  });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  assert.ok(toml.includes('[mcp_servers.good]'), '실행 가능한 서버는 실린다');
  assert.ok(!toml.includes('[mcp_servers.broken]'), '실행 불가 서버는 빠진다 — 턴 전체를 죽인다');
  assert.ok(toml.includes('[mcp_servers.remote]'), 'url 서버는 command 검사 대상이 아니다');
});

test('env는 TOML 하위 테이블로, 이스케이프해서 쓴다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-codexcfg-env-'));
  await writeCodexTurnConfig(home, {}, [], {
    withenv: { command: process.execPath, env: { TOKEN: 'a"b\\c' } },
  });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  assert.ok(toml.includes('[mcp_servers.withenv.env]'), 'env 하위 테이블');
  assert.ok(toml.includes('TOKEN = "a\\"b\\\\c"'), '따옴표·역슬래시 이스케이프');
});
