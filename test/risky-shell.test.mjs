// 메신저 문맥 셸 명령 결정적 위험 분류 → 서버 결재(D28). 정비사 원장 P-C9: 주인 턴 `rm -rf ./old-reports`가 결재 없이 실행됐다 —
// 결재가 모델의 request_approval 호출에만 달려 있었다("프롬프트는 힌트, 코드가 보장"). 분류 표는 test/helpers/risky-shell-cases.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RISKY_SHELL_CASES } from './helpers/risky-shell-cases.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-riskyshell-'));
const { classifyShell, normalizeShell } = await import('../src/risky-shell.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { loadApprovals, resolveApproval } = await import('../src/approvals.mjs');
const { approvalRisk } = await import('../src/approval-risk.mjs');

const WS = 'riskco';
const ROOT = join(process.env.ARGO_ROOT, WS);
await mkdir(ROOT, { recursive: true });
const MSGR = { orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1' };

test('분류 표 전수 — 양성은 규칙 id, 음성(비슷하지만 고위험 아님)은 null', () => {
  for (const [cmd, want] of RISKY_SHELL_CASES) assert.equal(classifyShell(cmd)?.id ?? null, want, cmd);
  assert.equal(classifyShell('rm -rf x', 'en').label, 'recursive delete', '영어 이름표');
  assert.equal(normalizeShell('  rm   -rf \t ./a  '), 'rm -rf ./a');
});

test('메신저 턴 고위험 셸: 카드(고위험)를 만들고 막는다 → 재요청은 같은 결재 → 승인 뒤 한 번만 허용 → 다시 하면 새 결재', async () => {
  const gate = makePermissionGate(WS, 'seoyun', ROOT, null, 'ko', [], { msgr: MSGR });
  assert.equal((await gate('Bash', { command: 'ls -la' })).behavior, 'allow', '저위험은 종전처럼 즉시');
  const d1 = await gate('Bash', { command: 'rm -rf ./old-reports' });
  assert.equal(d1.behavior, 'deny');
  assert.match(d1.message, /결재를 올렸다\(ap-/);
  let list = (await loadApprovals(WS)).filter((a) => a.payload?.shell);
  assert.equal(list.length, 1);
  const ap = list[0];
  assert.deepEqual([ap.status, ap.slug, ap.payload.shell, ap.payload.rule, ap.msgr?.channelId], ['pending', 'seoyun', 'rm -rf ./old-reports', 'recursive-delete', 'ch-1']);
  assert.equal(approvalRisk(ap), 'high', '카드는 고위험 — 조직 정책의 결재권자(approval_high_by)가 확정');
  assert.equal((await gate('Bash', { command: 'rm  -rf   ./old-reports' })).behavior, 'deny', '띄어쓰기만 바꿔 재요청해도 막힌다');
  assert.equal((await loadApprovals(WS)).filter((a) => a.payload?.shell).length, 1, '대기 중이면 새 카드를 만들지 않는다');
  await resolveApproval(WS, ap.id, true);
  assert.equal((await gate('Bash', { command: 'rm -rf ./old-reports' })).behavior, 'allow', '승인된 같은 명령은 실행');
  assert.ok((await loadApprovals(WS)).find((a) => a.id === ap.id).payload.consumedAt, '승인 한 번 = 실행 한 번(사용 표시)');
  assert.equal((await gate('Bash', { command: 'rm -rf ./old-reports' })).behavior, 'deny', '같은 명령을 또 하면 다시 결재');
  assert.equal((await loadApprovals(WS)).filter((a) => a.payload?.shell && a.status === 'pending').length, 1, '새 결재 1건');
});

test('승인은 그 채널·그 크루에만 — 다른 채널이나 다른 크루는 승인을 쓰지 못한다', async () => {
  const cmd = 'git push --force origin main';
  const a = makePermissionGate(WS, 'minjun', ROOT, null, 'ko', [], { msgr: MSGR });
  await a('Bash', { command: cmd });
  const ap = (await loadApprovals(WS)).find((x) => x.payload?.shell === cmd && x.status === 'pending');
  await resolveApproval(WS, ap.id, true);
  const other = makePermissionGate(WS, 'minjun', ROOT, null, 'ko', [], { msgr: { ...MSGR, channelId: 'ch-2' } });
  assert.equal((await other('Bash', { command: cmd })).behavior, 'deny', '다른 채널');
  const otherCrew = makePermissionGate(WS, 'seoyun', ROOT, null, 'ko', [], { msgr: MSGR });
  assert.equal((await otherCrew('Bash', { command: cmd })).behavior, 'deny', '다른 크루');
  assert.equal((await a('Bash', { command: cmd })).behavior, 'allow', '승인한 그 크루·그 채널은 실행');
});

test('메신저가 아닌 턴(데스크톱 채팅)은 이번 범위 밖 — 종전처럼 허용하고 결재를 만들지 않는다, 금지 구역 방어는 그대로', async () => {
  const before = (await loadApprovals(WS)).length;
  const gate = makePermissionGate(WS, 'luca', ROOT, null, 'ko', [], {});
  assert.equal((await gate('Bash', { command: 'rm -rf ./tmp-build' })).behavior, 'allow');
  assert.equal((await loadApprovals(WS)).length, before, '결재 없음');
  const msgr = makePermissionGate(WS, 'luca', ROOT, null, 'ko', [], { msgr: MSGR });
  const hard = await msgr('Bash', { command: 'cat capabilities.json' });
  assert.equal(hard.behavior, 'deny', '금지 구역 리터럴은 결재로 풀리지 않는 하드라인');
  assert.doesNotMatch(hard.message, /결재를 올렸다/);
});

test('SDK 두 번 판정(PreToolUse 훅 → canUseTool, 같은 호출 id): 승인 한 번으로 둘 다 허용되고 새 카드가 생기지 않는다', async () => {
  const { gateHooks } = await import('../src/permission-gate.mjs');
  const cmd = 'git reset --hard HEAD~1';
  const gate = makePermissionGate(WS, 'pepper', ROOT, null, 'ko', [], { msgr: MSGR });
  const hook = gateHooks(gate).PreToolUse[0].hooks[0];
  assert.equal((await hook({ tool_name: 'Bash', tool_input: { command: cmd } }, 'toolu_1')).hookSpecificOutput?.permissionDecision, 'deny', '결재 전 훅 거부');
  const ap = (await loadApprovals(WS)).find((x) => x.payload?.shell === cmd && x.status === 'pending');
  await resolveApproval(WS, ap.id, true);
  assert.deepEqual(await hook({ tool_name: 'Bash', tool_input: { command: cmd } }, 'toolu_2'), {}, '승인 뒤 훅 허용(승인 사용)');
  assert.equal((await gate('Bash', { command: cmd }, { toolUseID: 'toolu_2', signal: null })).behavior, 'allow', '같은 호출의 canUseTool도 허용');
  assert.equal((await loadApprovals(WS)).filter((x) => x.payload?.shell === cmd && x.status === 'pending').length, 0, '새 대기 결재 없음(실측 결함: 29ms 뒤 새 카드)');
  assert.equal((await gate('Bash', { command: cmd }, { toolUseID: 'toolu_3' })).behavior, 'deny', '다른 호출은 다시 결재');
});
