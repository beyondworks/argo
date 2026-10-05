// 결재 카드 쉬운 문장화(유건 확정 2026-09-26) 표시 재료 — JSX 없는 순수 함수만 모은 파일이다.
// App.jsx는 거대한 단일 파일이라 JSX 문법 때문에 plain node로 직접 import해 실행할 수 없다(이 레포의
// 모든 App.jsx 테스트가 소스를 텍스트로 읽어 정규식으로만 검사해 온 이유). 이 파일은 JSX가 전혀 없어
// node --test가 실제로 import해 호출·검증할 수 있다 — "행동 테스트"를 가능하게 하는 분리다.
//
// 분리 검수 M-2: msgr_crew_approvals.payload는 스키마 검증 없는 jsonb라, plain.purpose 등이 문자열이
// 아닌 값(객체·배열·숫자)으로 들어오면 그걸 그대로 JSX 자식으로 렌더링하는 순간 React가 던져
// 채널 화면 전체가 죽는다. 문자열만 통과시키는 단일 관문을 여기 둔다.

/** 문자열이고 트림 후 비어있지 않을 때만 통과 — 아니면 null(표시하지 않음, 화면 안 죽음). */
export function plainField(v) {
  return (typeof v === 'string' && v.trim()) ? v : null;
}

/** 결재 payload에서 쉬운 문장 3항목을 뽑는다. 값이 문자열이 아니면(손상·조작 데이터) 그 항목만 빠지고,
    셋 다 없으면(또는 전부 비문자열이면) null — 호출부가 원래 action/reason 폴백 카드로 그린다. */
export function approvalPlainFields(payload) {
  const p = payload && typeof payload === 'object' ? payload.plain : null;
  const purpose = plainField(p?.purpose);
  const task = plainField(p?.task);
  const need = plainField(p?.need);
  return (purpose || task || need) ? { purpose, task, need } : null;
}

/** "명령 보기"를 기본으로 펼쳐 둘지 — 고위험 결재는 결재자가 원문을 굳이 클릭하지 않아도 보이게 한다
    (분리 검수 M-1). risk 판정 자체는 approval-risk.mjs의 approvalRisk를 그대로 쓴다(새 판정 금지) —
    이 함수는 그 결과를 "펼침 여부"로 바꾸는 표시 규칙 하나뿐이다. */
export function approvalExpandDefault(ap) {
  return ap?.risk === 'high';
}

/** org_doc 카드 제목 — payload.title이 문자열이 아니어도 화면이 죽지 않게(같은 위험 모양, 분리 검수 M-2). */
export function orgDocTitle(payload, fallback = '') {
  const v = payload?.title;
  return typeof v === 'string' ? v : (fallback || String(v ?? ''));
}

/** 문자 전용 미리보기(알림함 한 줄 등)의 결재 요약 — plain 있으면 세 항목 + "명령: <action>" 한 줄,
    없으면 기존 action/reason. 분리 검수 H-1: plain이 있어도 실제 실행될 문장(action)이 항상 보여야 한다. */
export function approvalOneLineSummary(a, commandLabel) {
  const plain = approvalPlainFields(a?.payload);
  const action = typeof a?.action === 'string' ? a.action : String(a?.action ?? '');
  if (!plain) return a?.reason ? `${action} — ${a.reason}` : action;
  const bits = [plain.purpose, plain.task, plain.need].filter(Boolean).join(' · ');
  return `${bits} — ${commandLabel}: ${action}`;
}

// ── 폰 결재 페이지(유건 2026-10-02) ──
// 등급 표시 문구 — 서버 값(msgr_crew_approvals.risk: 'low' | 'high', src/approval-risk.mjs가 정하고 잠근다)은 그대로 두고 표시만 바꾼다.
// high → '꼭 확인'. low 중 회사 안 행동(approval-risk.mjs LOW_KINDS와 같은 집합: 프로필·영입·루프 재개) → '가벼운 일', 나머지 low → '보통'.
// 새 판정을 만들지 않는다 — 꼭 확인은 서버가 high로 잠근 것뿐이다(낮추는 쪽으로 틀리지 않게).
export const APPROVAL_GRADES = ['must', 'normal', 'light'];
const LIGHT_KINDS = new Set(['profile', 'hire', 'loop']);
export function approvalGrade(a) {
  if (!a || a.kind === 'join') return null; // 에이전트 넣기 요청은 결재 표가 아니라 등급이 없다
  if (a.risk === 'high') return 'must';
  return LIGHT_KINDS.has(a.kind) ? 'light' : 'normal';
}

/** 카드의 한두 줄 요약 — [i18n 키, 값]. 새 조회 없이 이미 받은 결재 행(payload·kind·action)만으로 만든다.
    목적+할 일 → "목적을 위해 할 일", 할 일만 → 그 문장, 조직 문서 → 제목, 연결 서비스 → 서비스·도구, 셸 → 명령, 없으면 기존 제목(action). */
export function approvalSummaryKey(a) {
  const plain = approvalPlainFields(a?.payload);
  const action = plainField(a?.action) ?? '';
  const p = a?.payload && typeof a.payload === 'object' ? a.payload : {};
  if (plain?.purpose && (plain.task || action)) return ['ap.sum.for', { purpose: plain.purpose, task: plain.task ?? action }];
  if (plain?.task) return ['ap.sum.text', { text: plain.task }];
  if (a?.kind === 'org_doc' && plainField(p.title)) return ['ap.sum.orgDoc', { title: p.title }];
  if (a?.kind === 'connector' && plainField(p.tool)) return ['ap.sum.connector', { server: plainField(p.serverId) ?? '', tool: p.tool }];
  if (p.shell && action) return ['ap.sum.shell', { cmd: action }];
  return ['ap.sum.text', { text: action }];
}

/** 결재 페이지에 보일 카드 — 대기 중인 결재와 에이전트 넣기 요청만, 같은 키는 한 번, 방금 결정한 것(done)은 빼고, 최신이 위 */
export function approvalPageItems(items, { done = new Set() } = {}) {
  const seen = new Set();
  return (items ?? []).filter((it) => (it?.kind === 'approval' || it?.kind === 'join') && (!it.status || it.status === 'pending') && !done.has(it.key) && !seen.has(it.key) && seen.add(it.key))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}
// ── 결재권 판정(분리 검수 M-2, 2026-10-02) — 데스크톱 슬립과 폰 결재 페이지가 같은 함수를 쓴다.
// 서버 msgr_can_decide(20260918193000)와 같은 갈래: low → 크루 소유자, high → 조직 정책(기본 관리자 · 'approvers'면 관리자 또는 지정 결재권자 · 'owner'면 크루 소유자).
// 화면용이다 — 최종 판정은 RLS. 크루를 모르면(crewOwnerId === undefined, 비활성 등) 소유자로 보고 버튼을 띄운다(데스크톱 검수 M1과 같은 규칙, 서버가 거절하면 안내).
export function approvalDecider({ ap, uid, crewOwnerId, isAdmin, policy }) {
  const high = approvalExpandDefault(ap);
  const mode = policy?.approval_high_by ?? 'admin';
  const byAdmin = high && mode !== 'owner';
  const owner = crewOwnerId === undefined ? true : crewOwnerId === uid;
  const isApprover = (policy?.approver_user_ids ?? []).includes(uid);
  return { can: byAdmin ? (!!isAdmin || (mode === 'approvers' && isApprover)) : owner, byAdmin, mode, high };
}

/** 폰 결재 페이지의 한 줄(loadApprovals가 붙인 crewOwnerId·policy) — 내 역할은 조직 목록(orgs[].role)에서. 넣기 요청은 서버가 결정할 사람에게만 보여 준 행이라 그대로 가능. */
export function phoneApprovalDecider(it, { uid, orgs } = {}) {
  if (it?.kind !== 'approval') return { can: true, byAdmin: false, mode: null, high: false };
  const role = (orgs ?? []).find((o) => o.id === it.org_id)?.role;
  return approvalDecider({ ap: it, uid, crewOwnerId: it.crewOwnerId, isAdmin: role === 'owner' || role === 'admin', policy: it.policy ?? null });
}

/** '결재 대기' 숫자·페이지 목록 — 내가 결정할 수 있는 것만 */
export const decidableApprovals = (items, ctx) => (items ?? []).filter((it) => phoneApprovalDecider(it, ctx).can);

/** 결정할 수 없는 카드·거절 안내 문구 키 — 정책의 결재권자 갈래면 approverOnly, 소유자 갈래면 ownerOnly */
export const approvalOnlyKey = (dec) => (dec?.byAdmin ? 'ap.approverOnly' : 'ap.ownerOnly');

/** 결정 쓰기가 결재권 때문에 막혔나 — USING에 걸리면 0행, WITH CHECK에 걸리면(예: high의 크루 소유자) RLS 오류(42501). 다른 오류(연결 등)는 아니다. */
export function approvalDenied(error, rows) {
  if (error) return error.code === '42501' || /row-level security/i.test(String(error.message ?? ''));
  return Array.isArray(rows) && rows.length === 0;
}

/** 접힌 카드의 명령 줄(분리 검수 M-3) — 'full' = 꼭 확인: 실제로 실행될 명령을 줄바꿈해 전부(데스크톱 approvalExpandDefault의 기본 펼침과 같은 규칙),
    'line' = 그 밖: 쉬운 문장이 있을 때 명령 한 줄(예전 approvalOneLineSummary와 같다 — 쉬운 문장이 없으면 요약이 곧 명령이라 겹쳐 그리지 않는다), null = 없음. */
export function approvalCmdMode(it) {
  if (!plainField(it?.action)) return null;
  if (approvalExpandDefault(it)) return 'full';
  return approvalPlainFields(it?.payload) ? 'line' : null;
}

/** 채널 안 결재 카드의 결정(MSG-07). 0행 = RLS가 막았거나(결재권 없음) 이미 결정된 결재(정책은 status='pending'만 갱신) — 다시 읽어 이미 결정됐으면
    오류 없이 결과만(연타·다른 사람이 먼저 결정), 대기 중일 때만 권한 없음. → { result: 'done'|'already'|'denied'|'error', status?, message? } */
export async function decideApproval({ update, reread }) {
  const res = await update();
  if (res?.error) return { result: 'error', message: res.error.message };
  if (res?.data?.length) return { result: 'done' };
  let cur;
  try { cur = await reread(); } catch (e) { return { result: 'error', message: e?.message || String(e) }; } // 다시 읽기가 실패하면 권한 없음이라고 하지 않는다(검수 L5)
  return cur?.status && cur.status !== 'pending' ? { result: 'already', status: cur.status } : { result: 'denied' };
}
/** 진행 중이면 다시 부르지 않는다(연타 — 두 번째 요청이 0행으로 잘못된 권한 오류를 냈다). 끝나면 다시 부를 수 있다 */
export function singleFlight(fn) {
  let busy = false;
  return async (...a) => { if (busy) return undefined; busy = true; try { return await fn(...a); } finally { busy = false; } };
}
