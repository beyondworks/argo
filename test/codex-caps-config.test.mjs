// codex 능력→샌드박스 config.toml 매핑 회귀 — 실사용 신고(2026-07-22, 김남) 고정:
// caps를 다 켜도 codex 크루만 "로컬능력 권한 실패", 사용자가 config.toml 수동 수정해 해결.
// 원인 = `-c sandbox_workspace_write.*` 오버라이드가 codex 버전 따라 거부/무시. config.toml은 안정 인터페이스.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-codexcfg-'));
const { writeCodexTurnConfig, codexSandboxArgs } = await import('../src/runners.mjs');

async function cfg(caps) {
  const home = await mkdtemp(join(tmpdir(), 'argo-ch-'));
  await writeCodexTurnConfig(home, caps);
  return readFile(join(home, 'config.toml'), 'utf8');
}

test('config.toml: fs 켜면 writable_roots=홈, browser 켜면 network_access (사용자 수동 수정의 자동화)', async () => {
  const c = await cfg({ fs: true, browser: true, shell: true });
  assert.ok(c.includes('[sandbox_workspace_write]'), '샌드박스 섹션 존재');
  assert.ok(c.includes(`writable_roots = ["${homedir()}"]`), 'fs → 홈 한정 쓰기(앱 본체 /Applications는 밖 — #16)');
  assert.ok(c.includes('network_access = true'), 'browser → 네트워크');
});

test('config.toml: 능력 꺼짐이면 샌드박스 섹션 없음(기본 workspace-write 그대로 — 회귀 없음)', async () => {
  const c = await cfg({ fs: false, browser: false, shell: false });
  assert.ok(!c.includes('[sandbox_workspace_write]'), '오버라이드 없음');
  assert.ok(c.includes('# Argo'), '관리 코멘트는 남아 codex가 읽을 config.toml이 항상 존재');
});

test('config.toml + -c 이중 경로: 같은 능력에서 두 매핑이 일치(신버전 -c, 구버전 config.toml)', async () => {
  const caps = { fs: true, browser: true };
  const c = await cfg(caps);
  const flags = codexSandboxArgs(caps).join(' ');
  // -c와 config.toml이 같은 키·값을 가리킨다 — 어느 쪽이 먹든 동일 결과
  assert.ok(flags.includes(`writable_roots=["${homedir()}"]`) && c.includes(`writable_roots = ["${homedir()}"]`));
  assert.ok(flags.includes('network_access=true') && c.includes('network_access = true'));
});
