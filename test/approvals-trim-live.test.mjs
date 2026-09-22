// K69 — 결재 저장 시 상태와 무관하게 최신 200건만 남기면 오래된 대기(pending)·승인 미사용 셸 결재가 사라진다
// ("존재하지 않는 결재", 승인한 셸 명령이 영영 실행 안 됨). 잘라내기는 끝난 이력에만 적용돼야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-approvals-trim-'));
process.env.ARGO_ROOT = ROOT;
const { addApproval, loadApprovals, resolveApproval, consumeShellApproval } = await import('../src/approvals.mjs');
const { paths } = await import('../src/workspace.mjs');

test('끝난 이력 200건이 넘게 쌓여도 오래된 대기·승인 미사용 결재는 남는다', async () => {
  const ws = 'w1';
  await mkdir(paths(ws).root, { recursive: true });
  await writeFile(paths(ws).approvals, '[]');
  const oldPending = await addApproval(ws, { slug: 'pepper', action: '오래된 대기 결재' });
  const oldShell = await addApproval(ws, { slug: 'pepper', action: '셸', kind: 'tool', payload: { shell: 'rm -rf build' } });
  await resolveApproval(ws, oldShell.id, true);
  for (let i = 0; i < 210; i++) {
    const it = await addApproval(ws, { slug: 'pepper', action: `처리된 ${i}` });
    await resolveApproval(ws, it.id, false);
  }
  const list = await loadApprovals(ws);
  assert.ok(list.some((a) => a.id === oldPending.id), '오래된 대기 결재가 남아 있다');
  assert.equal((await resolveApproval(ws, oldPending.id, true)).status, 'approved', '대기 결재를 여전히 승인할 수 있다');
  assert.equal(await consumeShellApproval(ws, { slug: 'pepper', shell: 'rm -rf build' }), true, '승인 미사용 셸 결재를 쓸 수 있다');
  const resolved = (await loadApprovals(ws)).filter((a) => a.status !== 'pending' && !(a.status === 'approved' && a.payload?.shell && !a.payload?.consumedAt));
  // 상한 200 + 마지막 저장 때 대기였던 최신 1건 + 위에서 이 테스트가 끝낸 2건 = 203 (자르지 않으면 212)
  assert.ok(resolved.length <= 203, `끝난 이력은 여전히 잘린다(${resolved.length})`);
});
