// 결재함 — 되돌리기 어렵거나 외부로 나가는 행동은 크루가 실행 전 사장 승인을 받는다.
// 크루는 request_approval 도구로 요청만 등록하고 대기, 사장이 승인하면 후속 턴이 실행을 잇는다.
import { paths } from './workspace.mjs';
import { emitNotify } from './notify.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

const lockKey = (wsId) => `approvals:${wsId}`;

export async function loadApprovals(wsId) {
  // 결재 대기열은 유실이 치명적 — 손상을 조용히 빈 목록으로 리셋하지 않고 throw로 드러낸다.
  return readJson(paths(wsId).approvals, []);
}

async function save(wsId, list) {
  await writeJsonAtomic(paths(wsId).approvals, list);
}

/** 결재 요청 등록 — kind: 'action'(행동 결재, 승인 시 후속 턴) | 'tool'(권한 게이트, 승인 시 그 자리에서 재개)
    | 'capability'(능력 켜기 제안 — 승인 시 능력 on + 후속 턴이 원래 요청 재개). cap은 capability 전용. */
export async function addApproval(wsId, { slug, action, reason, kind = 'action', cap, payload }) {
  // 락 안에서 read-modify-write — 두 크루가 동시에 결재를 등록해도 유실 없음
  const item = await withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = {
      id: `ap-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      slug, kind, ...(cap ? { cap } : {}),
      // payload — 승인 시 서버가 실행할 구조화 데이터(profile 변경·hire 스펙). 300자 상한의 action과 별개
      ...(payload ? { payload } : {}),
      action: String(action).slice(0, 300),
      reason: String(reason ?? '').slice(0, 500),
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    list.unshift(it);
    await save(wsId, list.slice(0, 200)); // 오래된 이력은 흘려보낸다
    return it;
  });
  emitNotify({ type: 'approval', wsId, item }); // 메신저로 결재 버튼 푸시
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: 'pending' });
  return item;
}

/** 승인/거절 — 상태만 바꾼다. 후속 턴 실행은 API 계층 책임.
    락 안에서 상태를 재확인하므로, 같은 결재에 두 요청(데크 카드+채팅 카드, 웹+메신저)이
    동시에 와도 두 번째는 'approved'를 보고 막힌다 — 되돌릴 수 없는 후속 턴 이중 실행 차단. */
export async function resolveApproval(wsId, id, approve) {
  const item = await withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = list.find((a) => a.id === id);
    if (!it) throw new Error('존재하지 않는 결재입니다');
    if (it.status !== 'pending') throw new Error('이미 처리된 결재입니다');
    it.status = approve ? 'approved' : 'rejected';
    it.resolvedAt = new Date().toISOString();
    await save(wsId, list);
    return it;
  });
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: item.status });
  return item;
}

/** 만료 — 대기 자리를 떠난 tool 결재를 'expired'로 내린다(승인해도 아무 일 없는 죽은 버튼 제거).
    이미 처리(승인/거절)된 건 건드리지 않는다. 반환: 만료시켰으면 item, 아니면 null. */
export async function expireApproval(wsId, id) {
  const item = await withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = list.find((a) => a.id === id);
    if (!it || it.status !== 'pending') return null;
    it.status = 'expired';
    it.resolvedAt = new Date().toISOString();
    await save(wsId, list);
    return it;
  });
  if (item) await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: 'expired' });
  return item;
}
