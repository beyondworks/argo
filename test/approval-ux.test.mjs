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

test('CAPABILITY_DEFS: bypass는 정식 토글(준비 작업 자동 승인) — 사람 판단은 결재 유지', () => {
  // 유건 지시 2026-07-26로 복귀: 도구 설치·능력 켜기는 자동 승인, 발송·게시·구매·삭제는 그대로 결재.
  const bypass = CAPABILITY_DEFS.find(([k]) => k === 'bypass');
  assert.ok(bypass, 'UI에서 켜고 끌 수 있어야 한다');
  assert.equal(CAPABILITY_DEFS.length, 4);
  assert.match(bypass[2], /발송|구매|삭제/, '자동 승인이 미치지 않는 경계가 설명에 보여야 한다');
  assert.ok(CAPABILITY_DEFS.filter(([k]) => k !== 'bypass').every(([, , d]) => d.includes('결재 없이')));
});

test('loadCapabilities: bypass 설정이 로드에서 되돌려지지 않는다(옛 마이그레이션 제거)', async () => {
  const { loadCapabilities } = await import('../src/capabilities.mjs');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const ws2 = 'apvco2';
  await mkdir(join(process.env.ARGO_ROOT, ws2), { recursive: true });
  await writeJsonAtomic(paths(ws2).capabilities, { fs: false, browser: false, shell: false, bypass: true });
  const caps = await loadCapabilities(ws2);
  assert.equal(caps.bypass, true, '사용자가 켠 설정을 매 로드마다 끄면 안 된다');
  assert.equal(caps.fs, false, '다른 능력을 임의로 켜지 않는다');
  assert.equal((await loadCapabilities(ws2)).bypass, true, '반복 로드에도 유지');
});
