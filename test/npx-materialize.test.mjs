// MCP 실행형 구체화 — npx 계열 MCP가 시스템 npm 없는 기기에서도 돈다(유건 지시 2026-08-21).
// 네트워크 조달(provisionNpx)은 DI로 격리 — 테스트는 재작성 규칙만 값으로 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeMcpServers } from '../src/runners/npx.mjs';
import { noDockShimPath, withNoDock } from '../src/no-dock.mjs';

const SERVERS = {
  mem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  custom: { command: 'node', args: ['/x/server.js'] },
  remote: { url: 'https://example.com/mcp' },
  bin: { command: '/usr/local/bin/some-mcp', args: [] },
};

test('시스템 npx 없음 → 조달 npx-cli를 우리 노드로 실행하게 재작성', async () => {
  const out = await materializeMcpServers(SERVERS, { hasSystemNpx: () => false, provide: async () => '/managed/npx-cli.js' });
  assert.equal(out.mem.command, process.execPath, 'npx가 우리 노드로 바뀌어야 한다');
  assert.deepEqual(out.mem.args, ['/managed/npx-cli.js', '-y', '@modelcontextprotocol/server-memory'], '원래 인자가 뒤에 보존');
  assert.equal(out.custom.command, process.execPath, "command 'node'도 우리 노드로 고정");
  assert.deepEqual(out.custom.args, ['/x/server.js'], 'node 인자는 그대로');
  assert.equal(out.remote.url, 'https://example.com/mcp', 'url 서버는 원형');
  assert.equal(out.bin.command, '/usr/local/bin/some-mcp', '기타 바이너리는 원형');
});

test('시스템 npx 있음 → npx 원형 유지(사용자 npm 캐시 존중)', async () => {
  const out = await materializeMcpServers(SERVERS, { hasSystemNpx: () => true, provide: async () => { throw new Error('불러선 안 됨'); } });
  assert.equal(out.mem.command, 'npx');
  assert.deepEqual(out.mem.args, ['-y', '@modelcontextprotocol/server-memory']);
});

test('조달 실패 → 원형 유지(조용한 삭제 금지 — commandExists 게이트가 정직하게 거른다)', async () => {
  const out = await materializeMcpServers(SERVERS, { hasSystemNpx: () => false, provide: async () => { throw new Error('offline'); } });
  assert.equal(out.mem.command, 'npx', '실패 시 재작성하지 않는다');
});

test('입력 맵 불변 — 같은 맵을 SDK·CLI 두 경로가 이어 쓴다(scopeServers 계약과 동일)', async () => {
  await materializeMcpServers(SERVERS, { hasSystemNpx: () => false, provide: async () => '/m/npx-cli.js' });
  assert.equal(SERVERS.mem.command, 'npx', '원본이 바뀌면 뒤따르는 소비자가 오염된다');
});

test('macOS MCP 정의는 부모의 검증된 Dock 프리로드만 명시적으로 전달한다', { skip: process.platform !== 'darwin' }, async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = withNoDock('--trace-warnings', noDockShimPath());
  const servers = {
    ...SERVERS,
    custom: { ...SERVERS.custom, env: { NODE_OPTIONS: '--max-old-space-size=256', TOOL_SETTING: 'kept' } },
  };
  try {
    for (const hasNpx of [true, false]) {
      const out = await materializeMcpServers(servers, { hasSystemNpx: () => hasNpx, provide: async () => '/managed/npx-cli.js' });
      for (const name of ['mem', 'custom', 'bin']) {
        assert.equal(out[name].env.NODE_OPTIONS, withNoDock(servers[name].env?.NODE_OPTIONS, noDockShimPath()));
        assert.equal(out[name].env.HOME, undefined, '부모 env 전체를 MCP에 복사하지 않는다');
      }
      assert.equal(out.custom.env.TOOL_SETTING, 'kept');
      assert.equal(servers.custom.env.NODE_OPTIONS, '--max-old-space-size=256', '입력 불변');
      assert.equal(out.remote, servers.remote, '원격 서버에는 프로세스 설정을 넣지 않는다');
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});
