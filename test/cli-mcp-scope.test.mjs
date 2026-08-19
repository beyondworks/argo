// 크루별 MCP 범위가 codex 주입에도 걸리는지 — 분리 검수 2026-08-19 발견(v0.1.41 유입).
// 안내 목록(cliMcp)만 거르고 실제 주입(cliMcpServers)은 안 걸러, 카드에 `mcp:`로 범위를
// 좁혀도 codex 크루가 회사의 모든 서버를 config.toml로 받았다 = 범위 제한 무력화.
// 안내와 실제가 갈리면 안내가 거짓이 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');

test('codex 주입 대상은 mcpScope로 걸러진 집합이다', () => {
  // 주입 변수가 원본(allMcp)이 아니라 걸러진 집합을 받아야 한다
  assert.match(src, /const cliMcpServers = runner === 'codex' \? scoped : null;/,
    'cliMcpServers가 allMcp를 그대로 받으면 범위 제한이 무력화된다');
  assert.match(src, /const scoped = mcpScope[\s\S]{0,200}?mcpScope\.includes\(n\)/,
    'scoped가 mcpScope로 필터링돼야 한다');
});

test('안내 목록과 주입 집합이 같은 원천을 쓴다', () => {
  // 둘이 갈리면 "있다고 알려주고 안 주는" 거짓 안내가 다시 생긴다
  assert.match(src, /const cliMcp = runner === 'codex'\s*\n\s*\? Object\.keys\(scoped\)/,
    '안내 목록도 scoped에서 파생돼야 한다');
});

test('SDK 경로도 여전히 범위를 건다(대조군 — 이쪽이 원래 정본)', () => {
  assert.match(src, /if \(mcpScope\) servers = Object\.fromEntries\(Object\.entries\(servers\)\.filter\(\(\[n\]\) => mcpScope\.includes\(n\)\)\);/,
    'SDK 경로의 범위 필터가 사라지면 러너 간 규칙이 다시 갈린다');
});
