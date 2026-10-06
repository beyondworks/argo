// @멘션 후보 — 사람을 먼저, 크루를 뒤에(유건 제보 2026-09-11: 크루가 8명을 넘으면 상한에 잘려 채널에 들어온 사람이 아예 안 떴다).
// 나 자신은 뺀다(슬랙과 같다). 검색어가 있으면 이름 부분 일치. 상한 없음 — 후보가 이 채널의 참여 구성뿐이라 구성원은 전원 보여야 한다
// (유건 제보 2026-09-11 밤: 상한 8에 잘려 비공개 채널의 Walter·Wolff·Yoda가 '@'만 쳐서는 안 떴다). 팝업은 max-height + 스크롤.
// exclude = 본문에 이미 있는 멘션(kind:id) — 고른 것은 목록에서 빠진다(유건 2026-09-12). all = 맨 위 "@all"(이 채널의 모든 사람·크루).
export const ALL = Object.freeze({ kind: 'all', id: 'all', name: 'all' });
export function mentionCandidates({ q = '', crews = [], members = [], uid = null, max = Infinity, exclude = new Set(), all = true } = {}) {
  const needle = q.toLowerCase();
  const people = members.filter((m) => m.user_id !== uid).map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }));
  const agents = crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text }));
  const pool = [...people, ...agents].filter((x) => !exclude.has(`${x.kind}:${x.id}`));
  const rest = pool.filter((x) => !needle || x.name.toLowerCase().includes(needle));
  const head = all && pool.length > 0 && !exclude.has('all:all') && 'all'.startsWith(needle) ? [{ ...ALL }] : []; // 부를 사람이 남아 있을 때만; "@al"까지 쳐도 뜬다
  return [...head, ...rest].slice(0, max);
}
export const ALL_RE = /(^|\s)@all(?=$|[\s,.!?:;])/i;

// 본문의 @이름 → 멘션 배열. 긴 이름부터 맞추고 맞춘 구간은 지워, "@페퍼 (VPS)" 안의 "@페퍼"가 다른 크루로 새지 않게 한다
// (실사고 2026-09-11: 사설 채널 밖 페퍼가 답함). picked = 팝업에서 고른 것(같은 규칙으로 본문에 아직 있는지 확인).
// candidates = 이 채널에서 부를 수 있는 사람·크루만.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 이름 뒤에 붙은 호칭·조사(님·씨 + 아·야·은·는·이·가·을·를·에게·한테)는 이름의 일부가 아니다 — "@페퍼님", "@페퍼에게"도 페퍼(2026-10-05).
// 조사 뒤에도 경계(끝·공백·문장부호)가 와야 한다 — "@페퍼이다"는 아니다. 앞은 줄 처음이나 공백뿐이라 이메일(a@b.com)은 걸리지 않는다.
const JOSA = '(?:님|씨)?(?:에게|한테|아|야|은|는|이|가|을|를)?';
const mentionRe = (name, flags = '') => new RegExp(`(^|\\s)@${esc(name)}${JOSA}(?=$|[\\s,.!?:;])`, `i${flags}`); // 대소문자 무시(@edna = Edna)
export function mentionsFromBody(body, candidates, picked = [], allCandidates = candidates) {
  if (ALL_RE.test(body)) { // @all = 이 채널의 모든 사람·크루(후보 순서 = 사람 먼저·크루 순 — 릴레이 표기일 때만 서버가 이 순서로 크루 차례를 정한다)
    const seenAll = new Set();
    return allCandidates.filter((x) => x?.id && (x.kind === 'user' || x.kind === 'crew') && !seenAll.has(`${x.kind}:${x.id}`) && seenAll.add(`${x.kind}:${x.id}`)).map(({ kind, id }) => ({ kind, id }));
  }
  let text = body; const out = []; const seen = new Set();
  const allowed = new Set(candidates.map((x) => `${x.kind}:${x.id}`));
  const all = [...picked.filter((x) => allowed.has(`${x.kind}:${x.id}`)), ...candidates].filter((x) => x?.name).sort((a, b) => b.name.length - a.name.length);
  for (const x of all) {
    const key = `${x.kind}:${x.id}`; if (seen.has(key)) continue;
    const hit = mentionRe(x.name).exec(text); if (!hit) continue;
    seen.add(key); out.push({ kind: x.kind, id: x.id, at: hit.index });
    text = text.replace(mentionRe(x.name, 'g'), (m, lead) => lead + ' '.repeat(m.length - lead.length)); // 구간 소진 — 길이 유지
  }
  // 본문 등장 순서 — 릴레이(`@A > @B`, 2026-09-26부터 순서는 릴레이에서만)일 때 서버(msgr_bot_updates)가 이 배열 순서로 크루 차례를 정한다. 이름 길이 순으로 내보내면 "@Edna @Ogilvy"가
  // [Ogilvy, Edna]로 저장돼 뒷사람이 먼저 답한다(라이브 실측 2026-09-12 #175).
  return out.sort((a, b) => a.at - b.at).map(({ kind, id }) => ({ kind, id }));
}

// 같은 이름(대소문자 무시)이 이 방 후보에 둘 이상인데 목록에서 고르지 않고 직접 친 "@이름" — 누구를 부르는지 모르니 보내기 전에 멈춘다(2026-10-05).
// 긴 이름부터 맞추고 맞춘 구간은 지운다(mentionsFromBody와 같은 규칙) — "@페퍼 (VPS)"가 짧은 동명이인 '페퍼'로 따져지지 않게. @all은 모두라 모호하지 않다.
export function ambiguousMentions(body, candidates, picked = []) {
  if (ALL_RE.test(body)) return [];
  const groups = new Map();
  for (const x of candidates) { if (!x?.name) continue; const k = x.name.toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const pickedKeys = new Set(picked.map((x) => `${x.kind}:${x.id}`));
  let text = String(body ?? ''); const out = [];
  for (const [, g] of [...groups].sort((a, b) => b[0].length - a[0].length)) {
    const re = mentionRe(g[0].name); if (!re.test(text)) continue;
    const ids = new Set(g.map((x) => `${x.kind}:${x.id}`));
    if (ids.size > 1 && !g.some((x) => pickedKeys.has(`${x.kind}:${x.id}`))) out.push(g[0].name);
    text = text.replace(mentionRe(g[0].name, 'g'), (m, lead) => lead + ' '.repeat(m.length - lead.length));
  }
  return out;
}

// 방 밖 에이전트 멘션 — 본문의 @이름 중 이 방 후보(사람·크루)에 없는 조직 에이전트(D14). 멘션 후보는 방 안만 유지하고(유건 0.1.29 재확인),
// 전송 뒤 "이 방에 없어요" 안내를 띄우는 데만 쓴다. 방 안 이름을 먼저 지워 "@페퍼 (VPS)" 안의 "@페퍼"가 방 밖 동명으로 새지 않게(mentionsFromBody와 같은 규칙).
// 같은 이름이 여럿이면 맞춘 구간이 지워져 앞의 하나만 잡힌다 — 내 것 → 먼저 만든 것 순으로 앞에 둔다. 받는 목록은 켜진(active) 크루뿐이고
// 충돌 사본은 조회 단계(withoutCopies)에서 이미 빠져 있다(실사고 2026-10-04: 사본 '페퍼'가 앞에 있어 [이 방에 추가]가 사본을 넣었다).
export function outsideCrewMentions(body, inRoom = [], orgCrews = [], uid = null) {
  let text = String(body ?? '');
  const blank = (m, lead) => lead + ' '.repeat(m.length - lead.length);
  for (const x of inRoom.filter((x) => x?.name).sort((a, b) => b.name.length - a.name.length)) text = text.replace(mentionRe(x.name, 'g'), blank);
  const inIds = new Set(inRoom.filter((x) => x?.kind === 'crew').map((x) => x.id));
  const rank = (c) => (c.owner_user_id === uid ? 0 : 1);
  const out = [];
  for (const c of orgCrews.filter((c) => c?.display_name && !inIds.has(c.id)).sort((a, b) => b.display_name.length - a.display_name.length || rank(a) - rank(b) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))) {
    if (!mentionRe(c.display_name).test(text)) continue;
    out.push(c); text = text.replace(mentionRe(c.display_name, 'g'), blank);
  }
  return out;
}
// 동기화 충돌 사본(본체 sync.mjs가 남기는 `<slug>.conflict-<기기>-<ts>` 카드가 옛 앱에서 미러된 크루)인가.
export const isCopyCrew = (c) => /\.conflict-/.test(c?.slug ?? '');
// 메신저 크루 목록에서 충돌 사본을 뺀다 — 고르기·@멘션·넣기·1:1 받는이 후보 어디에도 나오지 않게(재검수 #826 MEDIUM-2: 정렬만 바꾸면 1:1 후보·@ 팝업·
// 파견 전 목록·내 에이전트에 그대로 남았다). 조회 지점: loadOrg · 개인 공간 방 크루 · 내 에이전트 · 1:1 받는이 후보.
export const withoutCopies = (rows) => (Array.isArray(rows) ? rows.filter((r) => !isCopyCrew(r)) : rows);
// 크루 목록 순서 — 회사 크루 먼저, 이름순(QA: 화면마다 순서가 달랐다).
export const crewOrder = (isCompany) => (a, b) => isCompany(b) - isCompany(a) || a.display_name.localeCompare(b.display_name, 'ko');
// [이 방에 추가] 응답 → 안내 줄 상태. joined·already = 방에 있다(결과 줄만 보이고 구성원을 다시 읽는다), 그 밖은 방장에게 요청한 것.
export const outsideAddDone = (data) => (data === 'joined' || data === 'already' ? data : 'requested');
// 방 밖 안내 한 줄의 모양 — done: undefined | 'pending'(응답 대기) | 'joined' | 'already' | 'requested'.
// 들어간 뒤엔 '없어요'를 지운다(0.1.49: "없어요 · 넣었어요"가 한 줄에 같이 보였다).
// request: 'on'(누를 수 있음) | 'busy'(응답 대기 — 같은 글자로 꺼짐) | 'slot'(결과 뒤 — 보이지 않는 같은 크기 자리) | null(처음부터 없음: 남의 에이전트·1:1 방).
// 한 번 보인 버튼은 안내가 닫힐 때까지 크기·자리를 바꾸지 않는다 — 지우거나 글자가 짧아지면 줄바꿈·정렬이 바뀌어 더블탭 둘째 번이
// [1:1로 시키기]를 눌렀다(재검수 #826 N2 데스크톱 오른쪽 정렬, 3차 NEW-1 폰 폭 왼쪽 줄바꿈).
export function outsideRowView({ crew, uid, done, isDm, can }) {
  const request = crew?.owner_user_id === uid && !isDm ? (!done ? 'on' : done === 'pending' ? 'busy' : 'slot') : null;
  if (done === 'joined' || done === 'already') return { line: `mention.outside.${done}`, denied: false, suffix: null, request };
  return { line: 'mention.outside', denied: !can, suffix: done === 'requested' ? 'mention.outside.requested' : null, request };
}
// 방 밖에서 이 에이전트에게 시킬 수 있나(크루 시트 canMe와 같은 규칙 — 최종 판정은 서버 msgr_instruct_check).
export const canInstructCrew = (c, uid) => !!c && (c.owner_user_id === uid || c.allow === 'all' || (c.allow === 'list' && (c.allow_users ?? []).includes(uid)));
