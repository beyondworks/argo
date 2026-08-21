// gemini MCP 주입 — settings.json mcpServers(0.21.2 `gemini mcp list` 실프로브 2026-08-21: stdio·http 둘 다 해석).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { geminiMcpServers } from '../src/runners/gemini.mjs';
import { RUNNERS } from '../src/runners/catalog.mjs';

test('command 실재하는 stdio·url 서버만 gemini 형태로 — 깨진 command는 뺀다', () => {
  const out = geminiMcpServers({
    good: { command: process.execPath, args: ['-e', 'null'], env: { K: 'v' } },
    broken: { command: 'argo-definitely-missing-xyz' },
    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  });
  assert.deepEqual(Object.keys(out).sort(), ['good', 'remote']);
  assert.deepEqual(out.good, { command: process.execPath, args: ['-e', 'null'], env: { K: 'v' } });
  assert.deepEqual(out.remote, { httpUrl: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
});

test('카탈로그 mcp:true 집합 = chat.mjs 주입 집합(codex·gemini) — 화면 경고와 실제 주입이 어긋나지 않게', async () => {
  const flagged = Object.entries(RUNNERS).filter(([, r]) => r.kind === 'cli' && r.mcp).map(([k]) => k).sort();
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const m = src.match(/MCP_CLI_RUNNERS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'chat.mjs MCP_CLI_RUNNERS');
  const injected = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(injected, flagged);
  assert.ok(!flagged.includes('antigravity'), 'agy는 호스트 HOME 전용 설정 — 주입 안 함');
});
