// 첫 사용 안내(사용법 둘러보기, 유건 결정 2026-10-01) — 순수 로직만. 화면 그리기는 guide.jsx, 배선은 App.jsx.
// 실제 화면의 버튼·영역을 한 단계씩 짚는다. 짚을 요소가 없거나 숨어 있으면(목록이 접힘·조직 없음·폰에서 다른 구성)
// 그 단계는 화면 가운데 안내로 대신한다 — 빈 자리를 가리키거나 멈추지 않는다.
//
// 본 기록: 계정 단위(서버 msgr_my_guide_seen / msgr_mark_guide_seen) + 기기 캐시(localStorage). 서버 함수가 없거나(옛 서버)
// 닿지 않으면(오프라인) 기기 기록만으로 판정한다. 쓰기는 '완료/건너뛰기' 때 한 번 — 앱을 열 때마다 쓰지 않는다.

/** 안내 판 번호 — 내용이 크게 바뀌어 모두에게 다시 보여 줄 때만 올린다. */
export const GUIDE_VERSION = 1;
export const GUIDE_KEY = 'argo-msgr-guide';

// ── 단계 표(짚을 자리는 여기 한 곳에서만 정한다) ──
// targets는 앞에서부터 처음 보이는 것을 짚고, 대상마다 문구를 바꿀 수 있다(body). 하나도 안 보이면 fallback 문구로 가운데 안내.
// head: 대상이 너무 크면(긴 목록) 그 안의 머리(대상 기준 선택자)만 짚는다. note: 그 단계 아래 덧붙이는 한 줄(마지막 단계의 '다시 보기' 안내).
// 화면 쪽 표지는 data-tour="이름"(App.jsx). 자리가 바뀌면 이 표와 표지만 고친다.

/** 데스크톱(지금 화면) — 지금 폰 셸(홈·채팅·알림함 탭)도 이 표를 쓴다: 홈 큰 제목·떠 있는 +·채팅 탭에 같은 표지가 있다. */
export const DESKTOP_STEPS = [
  { id: 'space', title: 'guide.space.title', body: 'guide.space.body', fallback: 'guide.space.fallback',
    targets: [{ sel: '[data-tour="space"]' }] },
  { id: 'friends', title: 'guide.friends.title', body: 'guide.friends.body', fallback: 'guide.friends.fallback',
    targets: [{ sel: '[data-tour="friend-add"]' }] },
  { id: 'chat', title: 'guide.chat.title', body: 'guide.chat.body', fallback: 'guide.chat.fallback',
    targets: [{ sel: '[data-tour="chat-new"]' }, { sel: '[data-tour="chat-tab"]', body: 'guide.chat.tab' }] },
  { id: 'agents', title: 'guide.agents.title', body: 'guide.agents.body', fallback: 'guide.agents.fallback',
    targets: [{ sel: '.msgr-sec[data-sec="mine"]', head: ':scope > summary' }] },
  { id: 'call', title: 'guide.call.title', body: 'guide.call.body', fallback: 'guide.call.body',
    targets: [{ sel: '[data-tour="room-title"]' }] },
  { id: 'org', title: 'guide.org.title', body: 'guide.org.body', fallback: 'guide.org.fallback', note: 'guide.again',
    targets: [{ sel: '[data-tour="space"]' }] },
];

/**
 * 새 폰 셸(아래 탭 5개: 친구·채팅·채널·에이전트·기억 — 기준 문서 phone-v2-spec, 2026-10-01 유건 확정) — 탭을 하나씩 소개한다.
 * 그 탭이 열려 있어 위 버튼이 보이면 버튼을, 아니면 아래 탭을 짚는다. 표지가 없으면 가운데 안내.
 * 새 셸이 붙일 표지(data-tour):
 *   tab-friends · tab-chats · tab-channels · tab-agents · tab-memory  아래 탭 버튼
 *   hdr-add-friend  친구 탭 위 '사람+'      hdr-new-chat  채팅 탭 위 새 채팅
 *   org-switch      채널 탭 '조직 이름 ▾'   approvals-card  에이전트 탭 맨 위 '결재 대기 N'
 */
export const PHONE_STEPS = [
  { id: 'p-friends', title: 'guide.p.friends.title', body: 'guide.p.friends.tab', fallback: 'guide.p.friends.tab',
    targets: [{ sel: '[data-tour="hdr-add-friend"]', body: 'guide.p.friends.add' }, { sel: '[data-tour="tab-friends"]' }] },
  { id: 'p-chats', title: 'guide.p.chats.title', body: 'guide.p.chats.tab', fallback: 'guide.p.chats.tab',
    targets: [{ sel: '[data-tour="hdr-new-chat"]', body: 'guide.p.chats.new' }, { sel: '[data-tour="tab-chats"]' }] },
  { id: 'p-channels', title: 'guide.p.channels.title', body: 'guide.p.channels.tab', fallback: 'guide.p.channels.tab',
    targets: [{ sel: '[data-tour="org-switch"]', body: 'guide.p.channels.org' }, { sel: '[data-tour="tab-channels"]' }] },
  { id: 'p-agents', title: 'guide.p.agents.title', body: 'guide.p.agents.tab', fallback: 'guide.p.agents.tab',
    targets: [{ sel: '[data-tour="approvals-card"]', body: 'guide.p.agents.approvals' }, { sel: '[data-tour="tab-agents"]' }] },
  { id: 'p-memory', title: 'guide.p.memory.title', body: 'guide.p.memory.tab', fallback: 'guide.p.memory.tab', note: 'guide.p.again',
    targets: [{ sel: '[data-tour="tab-memory"]' }] },
];

/** 새 폰 셸이 그려졌는지 — 아래 탭 표지가 하나라도 있으면. 없으면(지금 셸) 데스크톱 표를 쓴다. */
export const PHONE_TABS_MARK = '[data-tour^="tab-"]';

/** 단계 목록 — 폰이고 새 셸이면 탭 소개, 그 밖(데스크톱·지금 폰 셸)은 데스크톱 표. */
export function guideSteps({ phone = false, phoneTabs = false } = {}) {
  return phone && phoneTabs ? PHONE_STEPS : DESKTOP_STEPS;
}

/**
 * 시작해도 되는 화면 — 짚을 버튼이 있는 루트 화면에서만.
 * 새 폰 셸은 아래 탭 루트 화면 이름(page)을 phone에 더한다(지금 셸은 홈 탭 'home').
 */
export const GUIDE_START_PAGES = { desktop: ['chat'], phone: ['home'] };

/** 단계 하나를 지금 화면에 맞춘다. probe(target) = 그 대상이 지금 보이면 참. 하나도 안 보이면 가운데 안내(target null). */
export function resolveStep(step, probe) {
  for (const target of step.targets) {
    if (probe(target)) return { id: step.id, title: step.title, body: target.body ?? step.body, target };
  }
  return { id: step.id, title: step.title, body: step.fallback ?? step.body, target: null };
}

// ── 언제 띄우나 ──

/** 기기 기록 읽기 — { v: 본 판 번호, synced: 서버에 남겼는가 | 'local'(서버에 남길 곳이 없음) }. 못 읽으면 안 본 것으로. */
export function readGuideRecord(storage, uid) {
  try {
    const all = JSON.parse(storage?.getItem(GUIDE_KEY) || '{}');
    const r = all && typeof all === 'object' ? all[uid] : null;
    return r && Number.isInteger(r.v) ? { v: r.v, synced: r.synced === true ? true : r.synced === 'local' ? 'local' : false } : { v: 0, synced: false };
  } catch { return { v: 0, synced: false }; }
}

/** 기기 기록 쓰기 — 같은 값이면 쓰지 않는다. 못 써도(사파리 개인 정보 보호 등) 안내는 그대로 닫힌다. */
export function writeGuideRecord(storage, uid, rec) {
  try {
    const all = JSON.parse(storage?.getItem(GUIDE_KEY) || '{}') || {};
    const cur = all[uid];
    if (cur && cur.v === rec.v && cur.synced === rec.synced) return false;
    all[uid] = { v: rec.v, synced: rec.synced };
    storage.setItem(GUIDE_KEY, JSON.stringify(all));
    return true;
  } catch { return false; }
}

/**
 * 앱을 열 때 할 일 — 서버 호출은 필요한 경우에만.
 *  · 'done'  : 이 기기에서 이미 봤고 서버에도 남았다(또는 남길 곳이 없다) → 호출 0
 *  · 'sync'  : 이 기기에서 봤는데 서버 기록이 실패했었다(오프라인) → 기록 한 번 다시
 *  · 'check' : 이 기기에서 안 봤다 → 서버에 다른 기기에서 봤는지 묻는다
 */
export function guidePlan(local, version = GUIDE_VERSION) {
  if (local.v >= version) return local.synced === false ? 'sync' : 'done';
  return 'check';
}

/** 서버 오류 가르기 — 함수가 없는 옛 서버는 'missing'(다시 묻지 않는다), 그 밖(오프라인·시간 초과)은 'error'. */
export function rpcFailure(err) {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? err ?? '');
  if (code === 'PGRST202' || code === '42883' || /could not find the function|schema cache|does not exist/i.test(msg)) return 'missing';
  return 'error';
}

/**
 * 서버 답으로 띄울지 정한다. server = { v } | { fail: 'missing' | 'error' }.
 * 서버가 답하지 못하면 기기 기록으로 물러난다 — 이 경로는 기기에서 안 봤을 때만 오므로 띄운다.
 */
export function guideDecision(server, version = GUIDE_VERSION) {
  if (server && Number.isInteger(server.v)) return server.v >= version ? 'seen' : 'show';
  return 'show';
}

/** 끝냈을 때 쓸지 — 이미 이 판을 본 기록이 서버까지 남아 있으면(다시 보기) 쓰지 않는다. */
export function shouldRecord(local, version = GUIDE_VERSION) {
  return !(local.v >= version && local.synced !== false);
}

// ── 앱 쪽 흐름(서버 호출은 rpc(name, args)로 주입 — supabase.rpc와 같은 { data, error } 모양) ──
const call = (rpc, name, args) => Promise.resolve().then(() => rpc(name, args)).then((r) => r ?? {}, (error) => ({ error }));

/** 서버에 '봤다'를 남기고 결과를 기기 기록의 synced로 옮긴다. 남길 곳이 없는 서버면 'local'(다시 시도하지 않는다). */
export async function guideMark({ storage, uid, rpc, version = GUIDE_VERSION }) {
  const { error } = await call(rpc, 'msgr_mark_guide_seen', { p_version: version });
  if (!error) writeGuideRecord(storage, uid, { v: version, synced: true });
  else if (rpcFailure(error) === 'missing') writeGuideRecord(storage, uid, { v: version, synced: 'local' });
  return !error;
}

/** 앱을 열 때 — 띄워야 하면 true. 이 기기에서 이미 봤으면 서버 호출 0(지난 기록이 실패했으면 기록만 한 번 다시). */
export async function guideOnLaunch({ storage, uid, rpc, version = GUIDE_VERSION }) {
  const plan = guidePlan(readGuideRecord(storage, uid), version);
  if (plan === 'done') return false;
  if (plan === 'sync') { await guideMark({ storage, uid, rpc, version }); return false; }
  const { data, error } = await call(rpc, 'msgr_my_guide_seen');
  const server = error ? { fail: rpcFailure(error) } : { v: Number.isInteger(data) ? data : 0 };
  if (guideDecision(server, version) === 'seen') { writeGuideRecord(storage, uid, { v: server.v, synced: true }); return false; } // 다른 기기에서 봤다
  return true;
}

/** 완료·건너뛰기 — 기기에 먼저 남기고(서버가 실패해도 다시 안 뜬다) 서버에 한 번. 다시 보기(이미 남음)면 쓰기 0. */
export async function guideOnFinish({ storage, uid, rpc, version = GUIDE_VERSION }) {
  if (!shouldRecord(readGuideRecord(storage, uid), version)) return false;
  writeGuideRecord(storage, uid, { v: version, synced: false });
  await guideMark({ storage, uid, rpc, version });
  return true;
}

/** 화면이 조용한가 — 다른 대화 상자·입력 중(키보드)·시작 화면이 없을 때. 상태로 모르는 창은 DOM에서 본다. */
export function guideCalm({ modalOpen = false, typing = false, splash = false } = {}) { return !modalOpen && !typing && !splash; }

/**
 * 지금 시작해도 되나 — 로그인 직후 다른 창(시트·초대·동의·확인 창)이나 입력 중이면 기다린다.
 * 폰·데스크톱마다 GUIDE_START_PAGES의 화면에서만(설정·검색·대화 안에서는 짚을 버튼이 안 보인다).
 */
export function guideReady({ loaded, phone, page, blockers = [], modalOpen = false, typing = false, splash = false }) {
  if (!loaded || !guideCalm({ modalOpen, typing, splash })) return false;
  if (blockers.some(Boolean)) return false;
  return GUIDE_START_PAGES[phone ? 'phone' : 'desktop'].includes(page);
}

// ── 어디에 그리나(좌표는 CSS px, 화면 왼쪽 위 기준) ──

/** 화면에서 쓸 수 있는 칸 — 안전 영역(노치·홈 바)과 여백을 뺀다. */
export function usableBox(view, safe = null, margin = 12) {
  const s = { top: 0, right: 0, bottom: 0, left: 0, ...safe };
  return { left: s.left + margin, top: s.top + margin, right: view.w - s.right - margin, bottom: view.h - s.bottom - margin };
}

/** 대상 사각형이 쓸 수 있는 칸 안에 충분히(넓이 기준 ratio 이상) 들어와 있나. */
export function mostlyVisible(rect, box, ratio = 0.6) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const w = Math.min(rect.left + rect.width, box.right) - Math.max(rect.left, box.left);
  const h = Math.min(rect.top + rect.height, box.bottom) - Math.max(rect.top, box.top);
  if (w <= 0 || h <= 0) return false;
  return (w * h) / (rect.width * rect.height) >= ratio;
}

/** 대상이 화면 높이의 maxShare보다 크면(긴 목록) 머리만 짚는다 — 화면 대부분이 밝아져 무엇을 가리키는지 흐려지지 않게. */
export function tooTall(rect, view, maxShare = 0.45) { return rect.height > view.h * maxShare; }

/** 여러 잘림 칸(스크롤 목록 등)과 겹치는 부분만 남긴다. 겹침이 없으면 null. */
export function clipTo(rect, clips) {
  let left = rect.left, top = rect.top, right = rect.left + rect.width, bottom = rect.top + rect.height;
  for (const c of clips) { left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.left + c.width); bottom = Math.min(bottom, c.top + c.height); }
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/**
 * 강조할 사각형 — 여백을 두르고 화면 안으로 자른다. 거의 안 남으면 null.
 * 안전 영역으로 자르지 않는다: 폰 하단 탭 바는 원래 홈 바 자리에 18px 걸쳐 있다(앱 설계) — 자르면 탭 글자가 잘린다(390×844 실측).
 * 노치 쪽은 머리 막대가 덮으므로 onTop 판정(가려짐)이 거른다. 안전 영역은 설명 카드 자리(placeCard)만 지킨다.
 */
export function spotRect(r, { view, pad = 6 } = {}) {
  const box = usableBox(view, null, 2);
  const left = Math.max(box.left, r.left - pad), top = Math.max(box.top, r.top - pad);
  const right = Math.min(box.right, r.left + r.width + pad), bottom = Math.min(box.bottom, r.top + r.height + pad);
  if (right - left < 8 || bottom - top < 8) return null;
  return { left, top, width: right - left, height: bottom - top };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

/**
 * 설명 카드 자리 — 대상 옆에 겹치지 않게. 데스크톱은 오른쪽 먼저(목록이 왼쪽), 폰은 아래·위 먼저.
 * 어느 쪽도 다 안 들어가면 가장 넓은 쪽에 붙이고 화면 안으로 민다. 대상이 없으면 가운데.
 */
export function placeCard({ spot, card, view, safe, gap = 12, margin = 12, phone = false }) {
  const box = usableBox(view, safe, margin);
  if (!spot) {
    return { side: 'center', x: clamp((box.left + box.right - card.w) / 2, box.left, box.right - card.w), y: clamp((box.top + box.bottom - card.h) / 2, box.top, box.bottom - card.h) };
  }
  const sr = spot.left + spot.width, sb = spot.top + spot.height;
  const midX = spot.left + spot.width / 2, midY = spot.top + spot.height / 2;
  const room = { right: box.right - (sr + gap), left: (spot.left - gap) - box.left, below: box.bottom - (sb + gap), above: (spot.top - gap) - box.top };
  const at = {
    right: () => ({ x: sr + gap, y: clamp(midY - card.h / 2, box.top, box.bottom - card.h) }),
    left: () => ({ x: spot.left - gap - card.w, y: clamp(midY - card.h / 2, box.top, box.bottom - card.h) }),
    below: () => ({ x: clamp(midX - card.w / 2, box.left, box.right - card.w), y: sb + gap }),
    above: () => ({ x: clamp(midX - card.w / 2, box.left, box.right - card.w), y: spot.top - gap - card.h }),
  };
  const order = phone ? ['below', 'above', 'right', 'left'] : ['right', 'below', 'above', 'left'];
  const fits = { right: room.right >= card.w, left: room.left >= card.w, below: room.below >= card.h, above: room.above >= card.h };
  const side = order.find((s) => fits[s]);
  if (side) return { side, ...at[side]() };
  // 다 안 들어감(아주 작은 창·큰 대상) — 세로로 가장 넓은 쪽에 붙이고 화면 안으로 민다(대상을 일부 가릴 수 있다)
  const best = room.below >= room.above ? 'below' : 'above';
  const p = at[best]();
  return { side: best, x: clamp(p.x, box.left, box.right - card.w), y: clamp(p.y, box.top, box.bottom - card.h) };
}
