// codex MCP 주입 게이트 — 실행 불가한 command를 config.toml에 실으면 codex 기동이 실패해
// **턴 전체가 죽는다**(주입 도입 전엔 없던 실패 모드, 자가 발견 2026-08-19).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
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
  await writeCodexTurnConfig(home, {
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
  await writeCodexTurnConfig(home, {
    withenv: { command: process.execPath, env: { TOKEN: 'a"b\\c' } },
  });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  assert.ok(toml.includes('[mcp_servers.withenv.env]'), 'env 하위 테이블');
  assert.ok(toml.includes('TOKEN = "a\\"b\\\\c"'), '따옴표·역슬래시 이스케이프');
});

test('config.toml은 0600으로 쓰인다 — MCP env 토큰이 평문으로 실리는 파일이다', async () => {
  // mcp.json을 0600으로 쓰는 것과 같은 근거(PR #258)인데 codex 쪽만 빠져 있었다(분리 검수 MED-2).
  const home = await mkdtemp(join(tmpdir(), 'argo-codexperm-'));
  await writeCodexTurnConfig(home, {
    tok: { command: process.execPath, args: ['-e', ''], env: { SOME_TOKEN: 'x' } },
  });
  const st = await stat(join(home, 'config.toml'));
  if (process.platform === 'win32') return; // POSIX 모드 없음 — mcp.json과 같은 한계
  assert.equal(st.mode & 0o777, 0o600, `config.toml 모드가 ${(st.mode & 0o777).toString(8)} — 토큰이 더 느슨하게 저장된다`);
});

test('살균 후 이름이 충돌하면 뒤엣것을 뺀다 — TOML 중복 테이블은 턴 전체를 죽인다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-codexdup-'));
  await writeCodexTurnConfig(home, {
    'my.tool': { command: process.execPath, args: ['-e', ''] },
    'my tool': { command: process.execPath, args: ['-e', ''] },
  });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  const tables = toml.split('\n').filter((l) => l.trim() === '[mcp_servers.my_tool]');
  assert.equal(tables.length, 1, `[mcp_servers.my_tool]이 ${tables.length}번 — 중복 테이블이면 codex가 config 파싱에서 죽는다`);
});

test('config.toml에 벤더 기능 플래그를 강제로 쓰지 않는다 — code_mode_host=false 강제가 0.148+에서 도구 전면 잠김을 만들었다(2026-08-25 사고, 설계 원칙)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-codexcfg-'));
  await writeCodexTurnConfig(home, { good: { command: process.execPath } });
  const toml = await readFile(join(home, 'config.toml'), 'utf8');
  assert.doesNotMatch(toml, /code_mode_host|\[features\]/, '벤더 기능 플래그가 관리 config에 되살아났다 — 다음 벤더 버전에서 의미가 바뀌는 시한폭탄(설계 원칙 위반)');
  // 화이트리스트 앵커 — 이 파일의 역할은 주석 + MCP 주입까지다. 그 밖의 최상위 테이블이 생기면 원칙 위반.
  const tables = toml.split('\n').filter((l) => /^\[(?!mcp_servers\.)/.test(l.trim()));
  assert.deepEqual(tables, [], `관리 config에 mcp_servers 외 테이블: ${tables.join(', ')}`);
});
