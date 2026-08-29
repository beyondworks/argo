// codex 샌드박스 폐지 회귀 가드 — 유건 지시 2026-08-21 "샌드박스 없이".
// 역사: 2026-07-22 "/" 전체 개방 크리티컬 → 홈 한정(writable_roots) → 그 홈 한정이 "사용 권한이
// 없다" 차단(윈도우 쓰기 전멸 클러스터 포함)의 뿌리가 되어 danger-full-access로 전환.
// 이 파일은 그 전환이 되돌아가지 않게 잠근다 — 샌드박스 오버라이드가 config.toml에 부활하면
// full-access 플래그와 어긋나 "고쳤는데 또 막힌다"가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-codexcfg-'));
const { writeCodexTurnConfig } = await import('../src/runners.mjs');

test('config.toml에 샌드박스 섹션이 없다 — danger-full-access와 한 몸', async () => {
  const home = await mkdtemp(join(tmpdir(), 'argo-ch-'));
  await writeCodexTurnConfig(home, null);
  const c = await readFile(join(home, 'config.toml'), 'utf8');
  assert.ok(!c.includes('[sandbox_workspace_write]'), '샌드박스 오버라이드 부활 — 권한 차단이 되돌아온다');
  assert.ok(!c.includes('writable_roots'), 'writable_roots 부활');
  assert.ok(c.includes('# Argo'), '관리 코멘트는 남아 codex가 읽을 config.toml이 항상 존재');
});

test('codex 호출이 danger-full-access를 쓰고 workspace-write로 되돌아가지 않는다', async () => {
  // 인자 조립이 인라인이라 값 테스트가 불가 — 호출부 표면을 잠근다(SDK_ALLOWED_TOOLS 불변식과 같은 방식).
  // readOnly 도입(2026-08-29): 기본은 danger-full-access, readOnly 턴(설명 생성)만 read-only. 삼항으로 표기.
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(src, /readOnly \? 'read-only' : 'danger-full-access'/, '기본 full-access가 사라졌거나 readOnly 분기가 없다');
  assert.doesNotMatch(src, /'--sandbox', 'workspace-write'/, 'workspace-write 복귀 — "사용 권한이 없다"가 되돌아온다');
  assert.doesNotMatch(src, /codexSandboxArgs/, '삭제된 샌드박스 매핑의 부활');
});
