// 크루별 MCP 범위가 codex 주입에도 걸리는지 — 분리 검수 2026-08-19 발견(v0.1.41 유입).
// 안내 목록(cliMcp)만 거르고 실제 주입(cliMcpServers)은 안 걸러, 카드에 `mcp:`로 범위를
// 좁혀도 codex 크루가 회사의 모든 서버를 config.toml로 받았다 = 범위 제한 무력화.
// 안내와 실제가 갈리면 안내가 거짓이 된다.
//
// 이 파일은 **행동**을 잠근다(재검수 2026-08-19 MED-D: 앞선 판본은 식별자 이름과 줄바꿈 배치까지
// 소스에서 고정해, 잡을 결함은 못 보면서 정당한 리팩터에는 거짓 red를 냈다). 남긴 소스 검사는
// "두 호출부가 그 하나를 쓴다" 한 줄뿐 — 사본이 갈리는 것이 이 결함의 본질이라 그것만 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scopeServers, parseScopeList } from '../src/persona.mjs';

const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
const SERVERS = { notion: { command: 'a' }, slack: { command: 'b' }, gh: { url: 'https://x' } };

test('범위 계약 — 미기재=전부, none=아무것도, 목록=지정한 것만', () => {
  assert.deepEqual(Object.keys(scopeServers(SERVERS, parseScopeList(''))), ['notion', 'slack', 'gh'],
    '미기재(null)는 회사 공용 전체 — 여기서 빈 집합을 주면 기존 크루가 도구를 통째로 잃는다');
  assert.deepEqual(Object.keys(scopeServers(SERVERS, parseScopeList('none'))), [],
    "'none'은 사용 안 함 — []가 truthy라 전부 통과시키는 실수가 나기 쉬운 자리다");
  assert.deepEqual(Object.keys(scopeServers(SERVERS, parseScopeList('notion, gh'))), ['notion', 'gh']);
  assert.deepEqual(Object.keys(scopeServers(SERVERS, parseScopeList('없는서버'))), [],
    '없는 이름만 지정하면 빈 집합 — 조용히 전부 여는 fail-open이면 안 된다');
});

test('범위 밖 서버의 정의(=env 토큰)까지 빠진다 — 이름만 거르면 비밀이 따라 나간다', () => {
  const scoped = scopeServers({ keep: { command: 'k', env: { A: '1' } }, drop: { command: 'd', env: { B: '2' } } }, ['keep']);
  assert.deepEqual(Object.keys(scoped), ['keep']);
  assert.equal(scoped.drop, undefined, '범위 밖 서버의 정의가 남으면 config.toml에 그 env가 실린다');
});

test('입력 원본을 건드리지 않는다 — 같은 맵을 SDK·CLI 두 경로가 이어 쓴다', () => {
  const input = { a: { command: 'x' }, b: { command: 'y' } };
  scopeServers(input, ['a']);
  assert.deepEqual(Object.keys(input), ['a', 'b'], '원본이 줄어들면 뒤따르는 소비자가 조용히 도구를 잃는다');
});

test('SDK 경로와 codex 주입이 같은 헬퍼 하나를 쓴다 (사본 금지)', () => {
  // 이 결함의 본질은 "두 경로가 각자 필터를 갖고 한쪽만 고쳐진 것"이라 호출 횟수를 잠근다.
  const calls = src.match(/scopeServers\(/g) ?? [];
  assert.equal(calls.length, 2, `scopeServers 호출이 ${calls.length}회 — SDK 턴과 codex 주입 두 곳이어야 한다`);
  assert.doesNotMatch(src, /mcpScope\.includes\(/,
    'chat.mjs가 범위 필터를 직접 다시 구현했다 — 사본이 갈리면 한쪽만 범위가 풀린다');
});
