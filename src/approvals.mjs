// 결재함 — 되돌리기 어렵거나 외부로 나가는 행동은 크루가 실행 전 사장 승인을 받는다.
// 크루는 request_approval 도구로 요청만 등록하고 대기, 사장이 승인하면 후속 턴이 실행을 잇는다.
import { paths } from './workspace.mjs';
import { emitNotify } from './notify.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

const lockKey = (wsId) => `approvals:${wsId}`;

// 결재 카드 문구 조작(개행·제어문자 주입) 방어 — request_tool_install의 cleanId와 같은 살균(단일 지점).
const sanitizeLine = (v, max) => String(v).replace(/[\r\n\t\x00-\x1f]+/g, ' ').trim().slice(0, max);

/** 쉬운 문장 3항목(목적·할 일·필요한 것) — 크루가 채웠을 때만 만든다. 하나도 없으면 null(폴백 신호:
    카드가 원래 action/reason을 그대로 보여준다). 값 하나하나 살균 + 상한(카드 한 줄 폭 기준). */
function sanitizePlain(plain) {
  if (!plain || typeof plain !== 'object') return null;
  const out = {};
  if (plain.purpose) out.purpose = sanitizeLine(plain.purpose, 200);
  if (plain.task) out.task = sanitizeLine(plain.task, 200);
  if (plain.need) out.need = sanitizeLine(plain.need, 200);
  return (out.purpose || out.task || out.need) ? out : null;
}

export async function loadApprovals(wsId) {
  // 결재 대기열은 유실이 치명적 — 손상을 조용히 빈 목록으로 리셋하지 않고 throw로 드러낸다.
  return readJson(paths(wsId).approvals, []);
}

async function save(wsId, list) {
  await writeJsonAtomic(paths(wsId).approvals, list);
}

/** 결재 요청 등록 — kind: 'action'(행동 결재, 승인 시 후속 턴) | 'tool'(권한 게이트, 승인 시 그 자리에서 재개)
    | 'capability'(능력 켜기 제안 — 승인 시 능력 on + 후속 턴이 원래 요청 재개). cap은 capability 전용.
    plain: {purpose, task, need} — 크루가 쉬운 문장으로 채운 결재 요약(request_approval 도구·CLI 지시 블록 전용,
    선택 항목). 하나도 안 채웠으면 undefined/null이 되어 카드가 원래 action/reason을 그대로 보여준다(폴백). */
export async function addApproval(wsId, { slug, from, action, reason, kind = 'action', cap, payload, msgr, scope, plain }) {
  // 락 안에서 read-modify-write — 두 크루가 동시에 결재를 등록해도 유실 없음
  const item = await withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const cleanPlain = sanitizePlain(plain);
    const it = {
      id: `ap-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      // from = 위임 원 크루 slug — 카드·메신저가 "누구의 위임으로 온 요청인지"를 보여준다(업무 흐름 가시화)
      slug, kind, ...(from ? { from } : {}), ...(cap ? { cap } : {}),
      // payload — 승인 시 서버가 실행할 구조화 데이터(profile 변경·hire 스펙). 300자 상한의 action과 별개
      ...(payload ? { payload } : {}),
      ...(cleanPlain ? { plain: cleanPlain } : {}),
      ...(scope ? { scope } : {}), // 메신저가 아닌 범위 턴(텔레그램 그룹·슬랙 채널·자동 턴 목적지)에서 올린 결재 — 후속 턴이 그 범위로 돈다(thread.mjs approvalScope)
      ...(msgr ? { msgr } : {}), // 팀 메신저 턴에서 올린 결재 — 카드 목적지(orgId·channelId·crewId). 푸시가 rowId·messageId를 덧붙인다
      action: String(action).slice(0, 300),
      reason: String(reason ?? '').slice(0, 500),
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    list.unshift(it);
    // 오래된 이력은 흘려보낸다 — 끝난 결재만. 대기·승인 미사용 셸 결재를 자르면 "존재하지 않는 결재"로 영영 막힌다(K69)
    let done = 0;
    await save(wsId, list.filter((a) => a.status === 'pending' || (a.status === 'approved' && a.payload?.shell && !a.payload?.consumedAt) || ++done <= 200));
    return it;
  });
  emitNotify({ type: 'approval', wsId, item }); // 메신저로 결재 버튼 푸시
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: 'pending' });
  return item;
}

/** item.plain(목적·할 일·필요한 것)을 사람이 읽는 여러 줄 문장으로 — 텔레그램·슬랙처럼 접힘 UI가 없는
    창구가 공유해서 쓴다(카드 UI는 각자 렌더링 + "명령 보기" 접힘). plain이 비어 있으면 null(호출부가 원래
    action/reason 문구로 폴백). */
export function approvalPlainText(item, lang = 'ko') {
  const p = item?.plain;
  if (!p || !(p.purpose || p.task || p.need)) return null;
  const lines = lang === 'en'
    ? [p.purpose && `Purpose: ${p.purpose}`, p.task && `Task: ${p.task}`, p.need && `Needs: ${p.need}`]
    : [p.purpose && `목적: ${p.purpose}`, p.task && `할 일: ${p.task}`, p.need && `필요: ${p.need}`];
  return lines.filter(Boolean).join('\n');
}

/** 메신저 셸 결재(D28) — 이 크루·이 채널에서 승인됐고 아직 쓰지 않은 같은 명령이 있으면 한 번 쓰고 true.
    승인 한 번 = 실행 한 번(같은 명령을 다시 하려면 다시 결재). 락 안에서 표시하므로 동시 턴이 같은 승인을 두 번 쓰지 못한다. */
export async function consumeShellApproval(wsId, { slug, shell, channelId = null }) {
  return withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = list.find((a) => a.status === 'approved' && a.slug === slug && a.payload?.shell === shell && !a.payload?.consumedAt
      && (a.msgr?.channelId ?? null) === (channelId ?? null));
    if (!it) return false;
    it.payload = { ...it.payload, consumedAt: new Date().toISOString() };
    await save(wsId, list);
    return true;
  });
}

/** 승인/거절 — 상태만 바꾼다. 후속 턴 실행은 API 계층 책임.
    락 안에서 상태를 재확인하므로, 같은 결재에 두 요청(데크 카드+채팅 카드, 웹+메신저)이
    동시에 와도 두 번째는 'approved'를 보고 막힌다 — 되돌릴 수 없는 후속 턴 이중 실행 차단. */
export async function resolveApproval(wsId, id, approve, { resolvedBy = null } = {}) {
  const item = await withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = list.find((a) => a.id === id);
    if (!it) throw new Error('존재하지 않는 결재입니다');
    if (it.status !== 'pending') throw new Error('이미 처리된 결재입니다');
    // H-2 협조적 강제(부록 K ②): 팀 메신저에서 올라온 결재를 서버가 "소유자는 확정 불가"로 판정했으면(고위험·조직 정책) 로컬 창구(웹·텔레그램·슬랙)에서도 거절한다.
    if (it.msgr?.ownerMayDecide === false && resolvedBy?.via !== 'msgr') throw new Error('조직 정책: 이 결재는 팀 메신저에서 조직 관리자(결재권자)만 확정할 수 있습니다');
    it.status = approve ? 'approved' : 'rejected';
    it.resolvedAt = new Date().toISOString();
    if (resolvedBy) it.resolvedBy = resolvedBy; // 누가 확정했나 {uid, via, at} — 팀 메신저(다중 사용자)에서 감사 근거. 기존 창구는 미기록(단일 사장)
    await save(wsId, list);
    return it;
  });
  await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: item.status });
  // 어느 창구(웹·대화창·텔레그램·슬랙)에서 확정됐든 메신저 카드의 버튼을 걷어내게 알린다(결재 UX).
  // item에 push 때 저장된 tg:{chatId,messageId}가 있으면 게이트웨이가 그 카드를 결과로 편집한다.
  emitNotify({ type: 'approval_resolved', wsId, item });
  return item;
}

/** 결재 항목에 메타 필드 병합(락 안) — 푸시 시 메신저 메시지 참조(tg:{chatId,messageId})를 심어
    나중에 어느 창구에서 승인하든 그 카드의 버튼을 정리할 수 있게 한다. */
export async function setApprovalMeta(wsId, id, patch) {
  return withLock(lockKey(wsId), async () => {
    const list = await loadApprovals(wsId);
    const it = list.find((a) => a.id === id);
    if (!it) return null;
    Object.assign(it, patch);
    await save(wsId, list);
    return it;
  });
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
  if (item) {
    await appendEvent(wsId, { type: 'approval', slug: item.slug, id: item.id, action: item.action, status: 'expired' });
    emitNotify({ type: 'approval_resolved', wsId, item }); // 만료된 죽은 버튼도 메신저에서 정리
  }
  return item;
}
