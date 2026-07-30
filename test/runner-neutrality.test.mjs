// 러너 중립성 계약 — 유건 원칙(2026-07-30): 어떤 러너·모델을 쓰든 Argo 환경 사용에 편파·제약이
// 없어야 한다(모델 성능 차이만 예외). 여기서 잠그는 것은 **편향이 되살아나는 두 자리**다:
//  ① 파일 반경이 러너마다 갈리는 것(openRoots 단일 계산을 codex·gemini·antigravity가 공유)
//  ② 한 벤더가 죽으면 회사가 서는 것(자가치유가 죽은 러너를 누적 제외하며 남은 러너를 다 시도)
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { openRoots } from '../src/workroots.mjs';
import { pickRunner } from '../src/runners/catalog.mjs';

test('openRoots — 홈(fs 능력) + 지정 작업 폴더를 이 순서로 연다', () => {
  assert.deepEqual(openRoots({ fs: true }, ['/w1', '/w2']), [homedir(), '/w1', '/w2']);
  assert.deepEqual(openRoots({ fs: false }, ['/w1']), ['/w1']); // 지정 폴더는 fs 능력과 독립
  assert.deepEqual(openRoots({ fs: false }, []), []);
  assert.deepEqual(openRoots(null), []); // caps 미전달(oneshot 등)도 안전
});

// 세 CLI 러너가 **같은 계산**을 쓴다는 계약. 이게 갈리면 같은 지시가 러너에 따라 되고 안 되고가
// 갈린다(실사고 2026-07-30: gemini에 인자를 안 넘겨 크루 책상이 회사 폴더 하나로 쪼그라들었고,
// "이 컴퓨터 어디든 쓸 수 있다"는 프롬프트가 거짓이 됐다).
test('codex writable_roots가 openRoots와 같은 목록을 싣는다', async () => {
  const { codexSandboxArgs } = await import('../src/runners/codex.mjs');
  const args = codexSandboxArgs({ fs: true }, ['/w1']);
  const roots = openRoots({ fs: true }, ['/w1']);
  const line = args.find((a) => String(a).startsWith('sandbox_workspace_write.writable_roots'));
  assert.ok(line, 'writable_roots 인자가 있어야 한다');
  for (const r of roots) assert.ok(line.includes(JSON.stringify(r)), `${r}가 writable_roots에 있어야 한다`);
});

test('pickRunner — exclude 목록을 받아 남은 러너를 고른다(자가치유 누적 제외)', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, codex: on, gemini: on, antigravity: on };
  // 라이브 재현 시나리오(2026-07-30): claude OAuth 만료 → codex 402. 이전엔 재시도가 1회뿐이라
  // 멀쩡한 gemini·antigravity가 시도조차 못 받고 영입이 통째로 실패했다.
  assert.equal(pickRunner(st, null, ['claude', 'codex']).runner, 'gemini');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini']).runner, 'antigravity');
  assert.equal(pickRunner(st, null, ['claude', 'codex', 'gemini', 'antigravity']).available, false);
  assert.equal(pickRunner(st, null, 'claude').runner, 'codex'); // 문자열 단수도 하위호환
  assert.equal(pickRunner(st, null, null).available, true);
});

test('pickRunner — 선호(want)도 exclude 목록에 걸리면 건너뛴다', () => {
  const on = { company: { connected: true, invalid: false } };
  const st = { claude: on, gemini: on };
  assert.equal(pickRunner(st, 'claude', ['claude']).runner, 'gemini');
  assert.equal(pickRunner(st, 'claude', []).runner, 'claude');
});
