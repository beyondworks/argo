// 결재 UX 회귀 테스트 — "전권 = 결재 없이 실행"·위임 출처(from) 가시화.
// 실사용 사고(2026-07-18): 능력을 켜도 grep/ls 하나하나 결재 카드가 와 흐름이 끊겼다.
// 2026-07-30부터 능력 토글 자체가 없다(capabilities.mjs) — 거절·제안 카드 경로가 사라졌다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apvtest-'));
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { addApproval, loadApprovals } = await import('../src/approvals.mjs');

const WS = 'apvco';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
const ROOT = join(process.env.ARGO_ROOT, WS);

test('게이트: 능력을 켰으면 결재 없이 즉시 실행(2단 모델 — 결재 폭탄 제거)', async () => {
  const gate = makePermissionGate(WS, 'pepper', ROOT);
  const t0 = Date.now();
  assert.equal((await gate('Bash', { command: 'ls' })).behavior, 'allow', 'shell 켬 → Bash 즉시 허용');
  assert.equal((await gate('Read', { file_path: '/etc/hosts' })).behavior, 'allow', 'fs 켬 → 밖 읽기 즉시 허용');
  assert.equal((await gate('Write', { file_path: '/tmp/x.txt' })).behavior, 'allow', 'fs 켬 → 밖 쓰기 즉시 허용');
  assert.equal((await gate('WebFetch', { url: 'https://example.com' })).behavior, 'allow', 'browser 켬 → 웹 즉시 허용');
  assert.ok(Date.now() - t0 < 3000, '대기 루프 없음 — 즉시 판정(이전엔 최대 3분 결재 대기)');
  const pend = (await loadApprovals(WS)).filter((a) => a.status === 'pending');
  assert.equal(pend.length, 0, '능력이 켜져 있으면 결재가 생성되지 않는다');
});

test('게이트: 전권이라 능력 부족으로 거절하거나 제안 카드를 만들지 않는다', async () => {
  // 옛 계약(능력 꺼짐 → deny + 켜기 제안 카드)은 없어졌다 — 켤 것이 없기 때문이다.
  // 회귀 방지 지점: 거절이 사라졌다고 결재함에 쓰레기가 쌓여서도 안 된다.
  const gate = makePermissionGate(WS, 'pepper', ROOT, 'luca');
  for (const [tool, input] of [['Bash', { command: 'ls' }], ['Read', { file_path: '/etc/hosts' }],
    ['Write', { file_path: '/tmp/y.txt' }], ['WebFetch', { url: 'https://example.com' }]]) {
    assert.equal((await gate(tool, input)).behavior, 'allow', `${tool}은 전권에서 허용`);
  }
  const caps = (await loadApprovals(WS)).filter((a) => a.status === 'pending' && a.kind === 'capability');
  assert.equal(caps.length, 0, '능력 결재는 더 이상 생성되지 않는다');
});

test('게이트: 워크스페이스 안은 능력과 무관하게 허용(기존 경계 유지)', async () => {
  const gate = makePermissionGate(WS, 'pepper', ROOT);
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

test('capabilities: 전권 상수이고 켜고 끄는 API가 없다', async () => {
  const mod = await import('../src/capabilities.mjs');
  assert.deepEqual(mod.CAPABILITIES, { fs: true, browser: true, shell: true, bypass: true });
  assert.equal(typeof mod.updateCapabilities, 'undefined', '없는 스위치는 조작될 수 없다');
  assert.equal(typeof mod.CAPABILITY_DEFS, 'undefined', 'UI 토글 목록도 없다');
});

test('loadCapabilities: capabilities.json에 무엇을 써도 무시된다 — 자가 승격 경로 소멸', async () => {
  // Hermes가 YOLO를 import 시점에 동결하는 이유와 같은 계약(capabilities.mjs 주석).
  // 실사고 2026-07-27: 크루가 이 파일에 {"bypass":true}를 쓰자 **다음 턴에** 셸을 획득했다.
  // 이제 값을 읽지 않으므로, 파일을 어떻게 조작해도 런타임 권한이 바뀌지 않는다.
  const { loadCapabilities, CAPABILITIES } = await import('../src/capabilities.mjs');
  const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const ws2 = 'apvco2';
  await mkdir(join(process.env.ARGO_ROOT, ws2), { recursive: true });
  await writeJsonAtomic(paths(ws2).capabilities, { fs: false, browser: false, shell: false, bypass: false });
  assert.deepEqual(await loadCapabilities(ws2), CAPABILITIES, '파일로 권한을 내리지도 올리지도 못한다');
  await writeJsonAtomic(paths(ws2).capabilities, { fs: 'evil', shell: 1 });
  assert.deepEqual(await loadCapabilities(ws2), CAPABILITIES, '손상·위조 값도 런타임에 영향이 없다');
  assert.ok(Object.isFrozen(CAPABILITIES), '상수는 동결 — 프로세스 안에서 변조 불가');
});

test('스캐폴드: 신규 회사에 capabilities.json을 만들지 않는다 — 읽지 않는 파일을 심으면 오해만 남는다', async () => {
  // 전권 전환 후에도 provision이 {전부 false}를 계속 썼다(#191 분리 검수 INFO). 사장이 그 파일을
  // 열면 "권한이 다 꺼져 있다"고 읽히는데 런타임은 전권이라, 파일과 실제가 정반대였다.
  const { existsSync } = await import('node:fs');
  const { ensureScaffold } = await import('../src/provision.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const ws3 = 'apvco3';
  await mkdir(join(process.env.ARGO_ROOT, ws3), { recursive: true });
  await ensureScaffold(ws3);
  assert.equal(existsSync(paths(ws3).capabilities), false, '읽지 않는 능력 파일을 생성하지 않는다');
  assert.ok(existsSync(paths(ws3).index), '스캐폴드 자체는 정상 동작(회귀 없음)');
});
