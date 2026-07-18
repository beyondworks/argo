// 결재 UX 회귀 테스트 — "능력 켬 = 결재 없이 실행"(2단 모델)·위임 출처(from) 가시화.
// 실사용 사고(2026-07-18): 능력을 켜도 grep/ls 하나하나 결재 카드가 와 흐름이 끊기고,
// 위임받은 크루의 결재가 맥락 없이 다른 채널로 왔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apvtest-'));
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { addApproval, loadApprovals } = await import('../src/approvals.mjs');
const { CAPABILITY_DEFS } = await import('../src/capabilities.mjs');

const WS = 'apvco';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
const ROOT = join(process.env.ARGO_ROOT, WS);

test('게이트: 능력을 켰으면 결재 없이 즉시 실행(2단 모델 — 결재 폭탄 제거)', async () => {
  const gate = makePermissionGate(WS, 'pepper', { fs: true, browser: true, shell: true }, ROOT);
  const t0 = Date.now();
  assert.equal((await gate('Bash', { command: 'ls' })).behavior, 'allow', 'shell 켬 → Bash 즉시 허용');
  assert.equal((await gate('Read', { file_path: '/etc/hosts' })).behavior, 'allow', 'fs 켬 → 밖 읽기 즉시 허용');
  assert.equal((await gate('Write', { file_path: '/tmp/x.txt' })).behavior, 'allow', 'fs 켬 → 밖 쓰기 즉시 허용');
  assert.equal((await gate('WebFetch', { url: 'https://example.com' })).behavior, 'allow', 'browser 켬 → 웹 즉시 허용');
  assert.ok(Date.now() - t0 < 3000, '대기 루프 없음 — 즉시 판정(이전엔 최대 3분 결재 대기)');
  const pend = (await loadApprovals(WS)).filter((a) => a.status === 'pending');
  assert.equal(pend.length, 0, '능력이 켜져 있으면 결재가 생성되지 않는다');
});

test('게이트: 능력이 꺼져 있으면 실행 대신 켜기 제안 카드 한 장(중복 없이)', async () => {
  const gate = makePermissionGate(WS, 'pepper', { fs: false, browser: false, shell: false }, ROOT, 'luca');
  assert.equal((await gate('Bash', { command: 'ls' })).behavior, 'deny', 'shell 꺼짐 → 거절');
  assert.equal((await gate('Bash', { command: 'pwd' })).behavior, 'deny', '재시도도 거절');
  const caps = (await loadApprovals(WS)).filter((a) => a.status === 'pending' && a.kind === 'capability' && a.cap === 'shell');
  assert.equal(caps.length, 1, '같은 능력 제안은 한 장만(결재 폭탄 방지)');
  assert.equal(caps[0].from, 'luca', '위임 출처(from)가 제안 카드에 실린다');
});

test('게이트: 워크스페이스 안은 능력과 무관하게 허용(기존 경계 유지)', async () => {
  const gate = makePermissionGate(WS, 'pepper', { fs: false, browser: false, shell: false }, ROOT);
  await writeFile(join(ROOT, 'note.md'), 'x');
  assert.equal((await gate('Read', { file_path: join(ROOT, 'note.md') })).behavior, 'allow', '안쪽 읽기는 항상 허용');
  assert.equal((await gate('Write', { file_path: join(ROOT, 'out.md') })).behavior, 'allow', '안쪽 쓰기는 항상 허용');
  assert.equal((await gate('TodoWrite', {})).behavior, 'allow', '경로 없는 도구 허용');
});

test('addApproval: 위임 출처(from) 저장 — 카드·메신저 표기의 원천', async () => {
  const it = await addApproval(WS, { slug: 'shuri', from: 'pepper', action: '외부 발송', reason: '테스트' });
  const saved = (await loadApprovals(WS)).find((a) => a.id === it.id);
  assert.equal(saved.from, 'pepper', 'from이 저장된다');
  const it2 = await addApproval(WS, { slug: 'shuri', action: '단독 작업', reason: '테스트' });
  const saved2 = (await loadApprovals(WS)).find((a) => a.id === it2.id);
  assert.ok(!('from' in saved2), '위임이 아니면 from 자체가 없다');
});

test('CAPABILITY_DEFS: bypass 토글 제거(능력 토글이 곧 즉시 실행) + 설명에 명시', () => {
  assert.ok(!CAPABILITY_DEFS.some(([k]) => k === 'bypass'), 'bypass는 설정에서 내려간다');
  assert.equal(CAPABILITY_DEFS.length, 3);
  assert.ok(CAPABILITY_DEFS.every(([, , desc]) => desc.includes('결재 없이')), '켜면 결재 없음이 설명에 보인다');
});

test('loadCapabilities: 레거시 bypass:true는 3능력 켬으로 1회 이행(전권 고착 방지)', async () => {
  const { loadCapabilities } = await import('../src/capabilities.mjs');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const ws2 = 'apvco2';
  await mkdir(join(process.env.ARGO_ROOT, ws2), { recursive: true });
  await writeJsonAtomic(paths(ws2).capabilities, { fs: false, browser: false, shell: false, bypass: true });
  const caps = await loadCapabilities(ws2);
  assert.deepEqual(caps, { fs: true, browser: true, shell: true, bypass: false }, '전권 → 3능력 켬 동등 이행');
  const again = await loadCapabilities(ws2);
  assert.equal(again.bypass, false, '이행은 1회로 고정(멱등)');
});
