// 노드 단일화 — 러너·MCP의 'node' 이름 해석이 항상 이 서버와 같은 노드로 떨어진다
// (유건 지시 2026-08-20). SDK는 cli.js를 executable:'node'(PATH 해석)로 스폰하고(sdk.mjs
// getDefaultExecutable), MCP command:'node'·codex config.toml도 PATH를 탄다 — 시스템 노드
// 부재면 ENOENT, 낡으면 문법 오류로 턴이 죽던 자리다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, delimiter, join } from 'node:path';
import '../src/runners/shared.mjs'; // 임포트 부수효과가 계약이다 — 최하층이라 모든 러너가 이걸 지난다

test("PATH 맨 앞이 이 프로세스 노드의 디렉토리다 — 'node' 스폰 = 아르고 노드", () => {
  const first = (process.env.PATH ?? '').split(delimiter)[0];
  assert.equal(first, dirname(process.execPath),
    "PATH[0]이 execPath 디렉토리가 아니다 — 러너가 러너쪽(시스템) 노드를 잡는다");
});

test("commandExists('node')가 번들 노드로 참이 된다 — 시스템 노드 없는 기기의 MCP", async () => {
  const { commandExists } = await import('../src/runners/codex.mjs');
  // PATH에서 execPath 디렉토리만 남겨 "시스템 노드 없는 기기"를 흉내 낸다(env 주입 — 전역 미오염)
  const env = { PATH: dirname(process.execPath), PATHEXT: '.EXE;.CMD' };
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  assert.equal(commandExists(name, env), true, '번들 노드 디렉토리만으로 node가 잡혀야 한다');
});
