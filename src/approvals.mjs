// 결재함 — 되돌리기 어렵거나 외부로 나가는 행동은 크루가 실행 전 사장 승인을 받는다.
// 크루는 request_approval 도구로 요청만 등록하고 대기, 사장이 승인하면 후속 턴이 실행을 잇는다.
import { readFile, writeFile } from 'node:fs/promises';
import { paths } from './workspace.mjs';
import { emitNotify } from './notify.mjs';
import { appendEvent } from './events.mjs';

export async function loadApprovals(wsId) {
  try {
    return JSON.parse(await readFile(paths(wsId).approvals, 'utf8'));
  } catch {
    return [];
  }
}

async function save(wsId, list) {
  await writeFile(paths(wsId).approvals, JSON.stringify(list, null, 2));
}

/** 결재 요청 등록 — kind: 'action'(행동 결재, 승인 시 후속 턴) | 'tool'(권한 게이트, 승인 시 그 자리에서 재개). */
export async function addApproval(wsId, { slug, action, reason, kind = 'action' }) {
  const list = await loadApprovals(wsId);
  const id = `ap-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const item = {
    id, slug, kind,
    action: String(action).slice(0, 300),
    reason: String(reason ?? '').slice(0, 500),
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  list.unshift(item);
  await save(wsId, list.slice(0, 200)); // 오래된 이력은 흘려보낸다
  emitNotify({ type: 'approval', wsId, item }); // 메신저로 결재 버튼 푸시
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: 'pending' });
  return item;
}

/** 승인/거절 — 상태만 바꾼다. 후속 턴 실행은 API 계층 책임. */
export async function resolveApproval(wsId, id, approve) {
  const list = await loadApprovals(wsId);
  const item = list.find((a) => a.id === id);
  if (!item) throw new Error('존재하지 않는 결재입니다');
  if (item.status !== 'pending') throw new Error('이미 처리된 결재입니다');
  item.status = approve ? 'approved' : 'rejected';
  item.resolvedAt = new Date().toISOString();
  await save(wsId, list);
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: item.status });
  return item;
}
