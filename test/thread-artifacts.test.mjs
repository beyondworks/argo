// 턴 기록 산출물(artifacts) 왕복 — 크루가 만든 문서 칩의 원천.
// ⚠ workspace.mjs의 WS_ROOT는 모듈 로드 시점에 고정된다 — env를 어떤 임포트보다 먼저 잡아야
// 격리가 산다(core.test.mjs에 넣었다가 워크트리 workspaces/에 쓰는 오염을 실측, 전용 파일로 분리).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-artifacts-'));
process.env.ARGO_ROOT = ROOT; // 반드시 thread.mjs(→workspace.mjs) 동적 임포트보다 먼저
const { appendTurn, loadThread } = await import('../src/thread.mjs');

test('appendTurn: artifacts가 크루 메시지에 보존된다(없으면 필드 자체가 없다)', async () => {
  await mkdir(join(ROOT, 'demo', 'chats'), { recursive: true });
  await appendTurn('demo', 'crew-a', {
    userMsg: '보고서 만들어줘', reply: '만들었습니다', handover: null, sessionId: null,
    artifacts: ['projects/20260720_x/보고서.md', 'projects/20260720_x/데이터.csv'],
  });
  await appendTurn('demo', 'crew-a', { userMsg: '고마워', reply: '넵', handover: null, sessionId: null });
  const t = await loadThread('demo', 'crew-a');
  const crews = t.messages.filter((m) => m.who === 'crew');
  assert.deepEqual(crews[0].artifacts, ['projects/20260720_x/보고서.md', 'projects/20260720_x/데이터.csv']);
  assert.equal('artifacts' in crews[1], false, '산출물 없는 턴은 필드 미기록(스레드 비대화 방지)');
  await rm(ROOT, { recursive: true, force: true });
});
