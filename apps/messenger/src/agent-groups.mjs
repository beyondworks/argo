// 폰 에이전트 탭 — 같은 에이전트를 한 줄로(유건 2026-10-02). 순수 함수만(DOM·React·supabase 없음) — 행동은 test/agent-groups.test.mjs.
// 크루 행은 공간마다 따로 있다(개인 공간 행 #779, 외부 봇의 개인 쌍둥이). 행은 그대로 두고 화면에서만 묶는다. 1:1은 개인 행 하나로 연다(agentRoomTarget).
//
// 같은 에이전트 판정 = 주인(owner_user_id) + 회사(ws_id) + slug.
//   · 본체 크루: 같은 Argo 회사(ws_id)의 같은 slug를 공간마다 파견한 행 — 서버 msgr_personal_room_crews도 개인 행의 접속 시각을
//     이 세 값이 같은 조직 행에서 빌려 온다(같은 크루로 본다).
//   · 외부 봇: 조직 봇 행(ws_id 'bot', slug 'bot-…' 무작위)과 그 개인 쌍둥이는 쌍둥이를 만들 때 slug를 그대로 복사한다(20261001140000).
//   · 셋 중 하나라도 모르면(옛 서버·조회 실패) 그 행은 id로만 — 다른 행과 잘못 합치지 않는 쪽으로 틀린다. 이름으로는 판정하지 않는다.
import { twinPaused } from './personal-bots.mjs';
import { agentKey, lookFillPlan } from './crew-face.mjs';
export { agentKey }; // 정의는 crew-face.mjs 한 곳 — 얼굴 지도(agentLooks)와 같은 판정이어야 해서(유건 2026-10-05)

export const AGENT_FILTERS = ['all', 'fav', 'mine', 'ext'];

/** 행 목록 → 묶음 목록(이름순). 묶음 안의 행은 개인 공간 먼저, 그 다음 orgOrder(조직 목록) 순서. 대표 이름·사진은 첫 행 */
export function groupAgents(rows, { orgOrder = [] } = {}) {
  const rank = (r) => (r.org_id == null ? -1 : (orgOrder.indexOf(r.org_id) + 1 || 1e6));
  const byKey = new Map();
  for (const r of rows ?? []) {
    if (!r?.id) continue;
    const k = agentKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    const list = byKey.get(k);
    if (!list.some((x) => x.id === r.id)) list.push(r);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const rs = list.slice().sort((a, b) => rank(a) - rank(b));
    return { key, rows: rs, id: rs[0].id, display_name: rs[0].display_name, role_text: rs.find((r) => r.role_text)?.role_text ?? null, avatar_url: rs.find((r) => r.avatar_url)?.avatar_url ?? null, ext: rs.some((r) => r.hosting === 'bot') };
  }).sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'ko'));
}

/** 지금 보고 있는 공간의 행, 없으면 첫 공간 — 설정 '내 에이전트'의 카드, 개인 행이 없는 에이전트의 1:1 */
export function rowForSpace(group, space, personalKey) {
  return group.rows.find((r) => (r.org_id ?? personalKey) === space) ?? group.rows[0];
}

// 에이전트 = 한 사람(유건 2026-10-03, P2). 내 에이전트와의 1:1은 개인 공간의 방 하나다 — 공간마다 따로 열지 않는다.
// 조직 이야기는 다음 단계의 '조직 기억 찾기'로 꺼낸다. 개인 행은 본체 0.1.92부터 모든 에이전트에 생긴다(그 전 본체는 조직 행만 — 종전대로 연다).
const isMinePersonal = (r, uid) => !!r && r.org_id == null && r.status === 'active' && !!uid && r.owner_user_id === uid;
// 봇 쌍둥이는 서버가 준비됐다고 줄 때만(ready === true — msgr_personal_room_crews가 주인에게만 준다) 1:1 대상이다. 다시 연결 필요('relink')·조직을 나감('left_org')이면
// 서버 _msgr_bot_twin이 NULL이라 개인 방 글이 봇에 가지 않는다(20261001140000) — 답이 없는 방이 된다. 준비 상태를 모르면(ready 없음) 대상으로 보지 않는다. 본체 크루는 개인 행이면 된다.
const roomReady = (r) => r.hosting !== 'bot' || r.ready === true;
const isRoomRow = (r, uid) => isMinePersonal(r, uid) && roomReady(r);

/** 줄을 눌렀을 때 열 행 — 내 에이전트는 개인 공간 행(1:1 방 하나). 개인 행이 없거나 1:1을 열 수 없는 쌍둥이면 rowForSpace(지금 공간, 없으면 첫 공간).
    그때 열 수 없는 내 쌍둥이는 다른 행이 있으면 후보에서 뺀다 — 지금 공간이 개인이면 rowForSpace가 그 쌍둥이를 다시 고른다. 남의 에이전트는 종전 판정 그대로 */
export function agentRoomTarget(group, { uid, space, personalKey }) {
  const room = group.rows.find((r) => isRoomRow(r, uid));
  if (room) return room;
  const rest = group.rows.filter((r) => !(isMinePersonal(r, uid) && !roomReady(r)));
  return rowForSpace(rest.length ? { ...group, rows: rest } : group, space, personalKey);
}

/** 줄의 상태(대기·답변 준비 중·다시 연결 필요)를 볼 행 — 대화할 수 없는 내 쌍둥이(다시 연결 필요·조직을 나감, personal-bots.mjs twinPaused)가 있으면 그 행.
    누르면 조직 1:1이 열려도 개인 방을 되살리려면 다시 연결해야 하니 그 안내를 가리지 않는다. 아니면 여는 행(agentRoomTarget) */
export function agentStateRow(group, opts) {
  return group.rows.find((r) => isMinePersonal(r, opts.uid) && twinPaused(r)) ?? agentRoomTarget(group, opts);
}

/** 조직 행 → 같은 에이전트(agentKey = 주인·회사·slug)의 내 활성 개인 공간 행, 없으면 null. 1:1을 열 수 있는지(봇 준비 상태)는 personalRoomFor가 본다.
    남의 크루는 키의 주인이 나와 달라 맞는 행이 없고, 셋 중 하나라도 모르는 행은 키가 id라 다른 행과 맞지 않는다 —
    다른 에이전트의 방을 잘못 여는 쪽이 아니라 종전 쪽으로 틀린다. rows = 내 크루 행 목록(같은 slug만 읽어 와도 된다) */
export function personalTwinOf(crew, rows, uid) {
  if (crew?.org_id == null) return null; // 조직 행만 — 개인 행 자체·조회에서 못 찾은 행은 바꿀 것이 없다
  const key = agentKey(crew);
  return (rows ?? []).find((r) => isMinePersonal(r, uid) && agentKey(r) === key) ?? null;
}

/** 조직에서 내 에이전트 1:1을 열 때의 관문 판정(App openDm) — 열 개인 행, 아니면 null(종전 조직 1:1).
    조회는 주입한다(App은 supabase, 테스트는 가짜):
      ownRows(slug) — 내 크루 행 중 그 slug(id·org_id·owner_user_id·ws_id·slug·status·hosting). 조직 크루 목록에는 회사(ws_id)가 없어 같은 에이전트를 가리려고 읽는다.
      roomCrews()   — msgr_personal_room_crews 결과. 봇 쌍둥이면 준비 상태(ready)를 여기서만 확인한다(본체 크루면 부르지 않는다).
    남의 크루·slug를 모르는 행은 조회 없이 null. 조회가 실패하거나 준비 상태를 확인할 수 없어도 null. */
export async function personalRoomFor(crew, { uid, ownRows, roomCrews }) {
  if (!crew?.slug || !uid || crew.owner_user_id !== uid) return null;
  try {
    const rows = await ownRows(crew.slug);
    const twin = personalTwinOf(rows?.find((r) => r.id === crew.id), rows, uid);
    if (!twin || twin.hosting !== 'bot') return twin;
    return (await roomCrews())?.find((r) => r.id === twin.id)?.ready === true ? twin : null;
  } catch { return null; }
}

/** 버튼 이름(유건 2026-10-04) — 조직 화면의 '1:1 대화'·'1:1로 시키기'가 개인 1:1로 가는지, **이미 가진 행만으로** 판정한다(조회하지 않는다).
    rows = 내 에이전트 목록(App myAgents — 조직 행은 회사(ws_id)가 있고, 개인 행은 msgr_personal_room_crews의 ready가 있다). 관문과 같은 함수(personalTwinOf + 1:1 대상 판정).
    판단할 수 없으면(목록 없음·이 크루의 내 조직 행 없음·남의 크루·개인 행이 대상 아님) false — 지금 문구 */
export function personalRoomKnown(crew, rows, uid) {
  if (!crew?.id || !rows?.length) return false;
  const twin = personalTwinOf(rows.find((r) => r.id === crew.id), rows, uid);
  return !!twin && isRoomRow(twin, uid);
}

// 옛 조직 1:1(유건 2026-10-05) — #819 이후 새 입구는 개인 1:1로 가지만, 그 전에 만든 조직 1:1이 대화 목록·알림함·알림 탭으로 다시 열려
// 기기마다 다른 방을 봤다. 그런 방을 열려고 하면 개인 1:1로 돌린다. 옛 방은 지우지 않는다(목록에 남고, 열리면 위에 안내 띠).
/** 내 에이전트와의 조직 1:1이면 그 크루 행 — 사람은 나 하나, 에이전트는 내 에이전트 하나인 조직 DM. 아니면 null
    (남의 에이전트 방은 주인과 나 둘이라 해당 없음, 사람 1:1·그룹 방·개인 방·구성원을 아직 모르는 방도 null — 종전대로 연다) */
export function legacyAgentDm(channel, members, { uid, crewOf }) {
  if (!channel || channel.kind !== 'dm' || channel.org_id == null || !uid || !Array.isArray(members)) return null;
  const users = members.filter((m) => m.member_kind === 'user'); const crewsIn = members.filter((m) => m.member_kind === 'crew');
  if (users.length !== 1 || users[0].member_id !== uid || crewsIn.length !== 1) return null;
  const crew = crewOf(crewsIn[0].member_id);
  return crew && crew.owner_user_id === uid ? crew : null;
}
/** 그 방 대신 개인 1:1로 갈지 — { crew, known: true }(개인 1:1이 있다고 안다: personalRoomKnown) / { crew, known: false }(내 에이전트 목록을 아직 모른다 —
    열면서 서버에 한 번 묻는다) / null(종전대로 그 방: 내 에이전트 방이 아니거나, 목록을 알고 개인 1:1 대상이 없다) */
export function agentDmRedirect(channel, members, { uid, crewOf, myAgents }) {
  const crew = legacyAgentDm(channel, members, { uid, crewOf });
  if (!crew) return null;
  if (myAgents == null) return { crew, known: false };
  return personalRoomKnown(crew, myAgents, uid) ? { crew, known: true } : null;
}

/** 입구별로 옛 방을 열지(분리 검수 2026-10-05 #1) — 무조건 개인 1:1로 돌리면 옛 방에 온 글(안 읽은 글·알림이 가리키는 글)을 볼 길이 없었다.
    'legacy' = 옛 방을 연다(방 위 안내 띠가 개인 1:1로 안내한다): 그 방에 안 읽은 글이 있거나, 입구가 그 방의 글을 가리킨다
      (알림함 'inbox'·OS 알림 'mac'·푸시 'push'·전경 카드 'card'·미리보기 'peek' — 보던 글을 열려고 누른 것). 모르는 입구도 글을 숨기지 않는 쪽.
    'personal' = 개인 1:1로: 안 읽은 글이 없고 방 자체를 여는 입구('list' — 대화 목록 줄: 데스크톱 레일·폰 채팅 탭). 크루 카드·멘션은 openDm이 따로 돌린다 */
export const ROOM_ENTRANCES = new Set(['list']);
export function agentDmRoute({ channel, unread, from }) {
  if ((unread?.[channel?.id]?.n ?? 0) > 0) return 'legacy';
  return ROOM_ENTRANCES.has(from) ? 'personal' : 'legacy';
}

/** 내 에이전트 개인 1:1 위 '이전 대화 보기'(분리 검수 2026-10-05 #2 — 유건 계정 실측: 페퍼 조직 1:1 글 282개, 개인 1:1 3개) — 그 에이전트의 옛 조직 1:1과 글 수.
    옛 조직 1:1 = 그 에이전트의 조직 행 하나와 나만 있는 그 조직의 DM(legacyAgentDm과 같은 판정). 조직마다 한 줄(방이 둘이면 글이 많은 쪽), 글 0개·보관한 방은 뺀다.
    crewId = 개인 1:1의 내 개인 행, rows = 내 크루 행(App ownCrews — 로그인 때 이미 읽은 것). 조회는 주입한다(App은 supabase, 테스트는 가짜):
      crewDms(조직 행 id들) → [{ channel_id, member_id, msgr_channels: { org_id, kind, archived_at } }]  — 그 행들이 든 채널 1건
      members(채널 id들)    → [{ channel_id, member_kind, member_id }]                                  — 1:1인지 구성원 1건
      count(채널 id)        → 글 수(삭제 제외, head count)                                              — 옛 방마다 1건(보통 1~2)
    방을 열 때만 부른다(App이 세션에 에이전트당 한 번 — 주기 조회 없음). 조직 행이 없거나 남의 행이면 조회 0. 실패하면 빈 목록(띠를 그리지 않는다) */
export async function earlierAgentDms(crewId, { uid, rows, crewDms, members, count }) {
  const mine = rows?.find((r) => r.id === crewId);
  if (!mine || mine.org_id != null || !uid || mine.owner_user_id !== uid) return [];
  const key = agentKey(mine);
  const orgRows = key.startsWith('id:') ? [] : rows.filter((r) => r.org_id != null && agentKey(r) === key);
  if (!orgRows.length) return [];
  try {
    const rowOf = new Map(orgRows.map((r) => [r.id, r]));
    const dms = ((await crewDms(orgRows.map((r) => r.id))) ?? []).filter((x) => x.msgr_channels?.kind === 'dm' && !x.msgr_channels.archived_at && x.msgr_channels.org_id === rowOf.get(x.member_id)?.org_id);
    if (!dms.length) return [];
    const ms = (await members([...new Set(dms.map((x) => x.channel_id))])) ?? [];
    const solo = dms.filter((x) => legacyAgentDm({ id: x.channel_id, kind: 'dm', org_id: x.msgr_channels.org_id }, ms.filter((m) => m.channel_id === x.channel_id), { uid, crewOf: (id) => rowOf.get(id) ?? null })?.id === x.member_id);
    const counted = await Promise.all(solo.map(async (x) => ({ channelId: x.channel_id, orgId: x.msgr_channels.org_id, n: Number(await count(x.channel_id)) || 0 })));
    const best = new Map();
    for (const r of counted) if (r.n > 0 && r.n > (best.get(r.orgId)?.n ?? 0)) best.set(r.orgId, r);
    return [...best.values()];
  } catch { return []; }
}
/** 그릴 줄 — 조직 목록 순서, 내가 나간 조직(목록에 없음 — 그 방은 이제 못 연다)은 빼고 조직 이름을 붙인다 */
export function earlierLines(list, orgs) {
  const order = new Map((orgs ?? []).map((o, i) => [o.id, i]));
  return (list ?? []).filter((x) => order.has(x.orgId)).sort((a, b) => order.get(a.orgId) - order.get(b.orgId)).map((x) => ({ ...x, org: orgs[order.get(x.orgId)].name ?? '' }));
}

/** 얼굴·사진 저장 — 같은 에이전트(agentLooks의 ids, 내 행만)를 한 요청으로. 지도를 모르면 누른 행 하나(종전).
    여러 행 저장이 거절되면(어느 조직의 정책 잠금 등 — 한 행이라도 막히면 문장 전체가 실패한다) 누른 행 하나만 다시 저장한다.
    그 행이 대표 행이 아니면 화면 얼굴(대표 기준 — agentLooks)은 그대로라 onlyHere로 알린다(분리 검수 2026-10-05 #6 — 부르는 쪽이 "이 공간에만 저장했어요").
    db = supabase 클라이언트(테스트는 가짜). 반환 { error, ids: 바뀐 행 id, onlyHere } */
export async function saveAgentLook(db, crewId, patch, looks) {
  const ids = looks?.get(crewId)?.ids?.length ? looks.get(crewId).ids : [crewId];
  const run = (list) => db.from('msgr_crews').update(patch).in('id', list).select('id');
  let r = await run(ids); let partial = false;
  if (r.error && ids.length > 1) { r = await run([crewId]); partial = true; }
  return { error: r.error ?? null, ids: (r.data ?? []).map((x) => x.id), onlyHere: partial && !r.error && looks?.get(crewId)?.seed !== crewId };
}

/** 얼굴·사진 채우기(분리 검수 2026-10-05 #3) — 얼굴을 한 번도 저장하지 않은 에이전트는 주인이 아닌 사람(조직 동료·개인 방 친구)이 자기가 보는 행 id로 그려
    같은 방에서도 사람마다 얼굴이 달랐다. 주인 메신저가 로그인 때 이미 읽은 내 크루 행으로 crew-face.mjs lookFillPlan이 고른 것만 쓴다(추가 읽기 0).
    쓰기마다 그 열이 비어 있는 행만(is null) — 저장한 뒤에는 조건이 거짓이라 다시 쓰지 않고, 다른 기기가 먼저 저장했거나 동시에 해도 같은 값이라 안전하다.
    실패는 조용히 넘긴다(다음 로그인 때 다시 — App이 세션에 한 번만 부른다, 재시도 루프 없음). 반환 [{ ids: 실제로 바뀐 행, patch }] — App이 내 크루 행에 덮어 둔다.
    부하: 로그인마다 읽기 0, 쓰기는 에이전트당 얼굴 1번 + 사진 1번(필요할 때만) 평생 — 그 뒤 모든 로그인에서 0 */
export async function fillAgentLooks(db, rows) {
  const done = await Promise.all(lookFillPlan(rows).map(async ({ col, ids, patch }) => {
    try {
      const r = await db.from('msgr_crews').update(patch).in('id', ids).is(col, null).select('id');
      return !r.error && r.data?.length ? { ids: r.data.map((x) => x.id), patch } : null;
    } catch { return null; } // 다음 로그인 때 다시
  }));
  return done.filter(Boolean);
}

/** 내 크루 행 읽기 하나로(분리 검수 2026-10-05 #4) — 얼굴 지도(로그인·복귀)와 내 에이전트 목록(loadMyAgents)이 같은 select(owner = 나)를 따로 불러 로그인 때 2건이었다.
    read({ epoch, reuse }) → Promise<{ rows, at, epoch }>(at = 그 읽기를 시작한 시각):
      · 같은 회차를 읽는 중이면(또는 reuse면) 그 약속을 같이 쓴다(요청 0) — 다른 회차(복귀)는 읽는 중이어도 새로 읽는다(통합 재검수 LOW: 앞 회차 읽기에 묻혀 복귀 읽기가 안 나갔다)
      · reuse면 같은 epoch(App syncEpoch — 복귀·재연결 회차)에 이미 읽은 결과를 쓴다(요청 0) — 로그인 때 버튼 이름 판정 재료(myAgentsAsked)
      · 그 밖(복귀 새 회차·폰 에이전트 탭에 들어감)은 새로 읽는다. 실패는 기억하지 않는다(다음 부름이 다시 읽는다). 늦게 온 앞선 읽기는 마지막 결과를 덮지 않는다 */
export function ownRowsReader(fetch, now = Date.now) {
  let pending = null; let last = null;
  return function read({ epoch = 0, reuse = false } = {}) {
    if (pending && (reuse || pending.epoch === epoch)) return pending.p;
    if (reuse && last && last.epoch === epoch) return Promise.resolve(last);
    const at = now();
    const p = new Promise((res) => res(fetch())).then((rows) => { const got = { rows, at, epoch }; if (!last || last.at <= at) last = got; return got; }); // 바로 부른다(동기로 던져도 거절된 약속으로)
    pending = { p, epoch };
    const clear = () => { if (pending?.p === p) pending = null; };
    p.then(clear, clear);
    return p;
  };
}

/** 방금 만든 개인 방이 목록에 들어왔는지 — 들어왔으면(또는 두 번 읽었으면) true, 읽는 동안 공간을 떠났으면 false(App openPersonalCrewDm).
    목록 읽기(load = loadPersonal)는 더 새 읽기가 시작되면 결과 없이 끝난다. 개인 공간에 들어가며 열린 방의 막대(대기 크루 이름 재조회)·방송·복귀가 그 사이 읽기를 시작하면 그렇고,
    목록에 없는 방을 고르면 '사라진 채널' 정리가 선택을 지워 마지막 방이 열린다(픽스처 실측 2026-10-04). sendFirstDm처럼 새 방이 없으면 한 번만 더 읽는다 */
export async function loadUntilListed(cid, { load, here }) {
  for (let i = 0; i < 2; i++) {
    const rows = await load(); if (!here()) return false;
    if (rows?.some((c) => c.id === cid)) return true;
  }
  return true;
}

// 공간 전환 안내(유건 2026-10-04) — 조직 화면에서 내 에이전트 1:1을 눌러 앱이 개인 공간으로 옮겨 간 직후 한 줄. 기존 토스트를 쓰고, 누르면 돌아간다.
export const MOVE_NOTICE_MS = 6000; // 전경 푸시 카드와 같은 6초 — 읽고 누를 시간(보통 안내 4초보다 길게)
/** 띄울지 — 조직(from)에서 개인 공간(to)으로 옮겼을 때만 { backTo: 직전 조직, backCh: 그 조직에서 보던 채널 }.
    폰 에이전트 탭(모든 공간을 보는 화면, source 'agents')에서 열었거나, 이미 개인 공간이었거나, 조직 경로로 갔으면(개인 행 없음·준비 안 됨) null */
export function spaceMoveNotice({ from, fromCh = null, to, source = null, personalKey }) {
  if (source === 'agents' || !from || from === personalKey || to !== personalKey) return null;
  return { backTo: from, backCh: fromCh ?? null };
}
/** 안내를 눌렀을 때 돌아갈 곳 — 직전 조직과 그 채널. 그 사이 그 조직을 나갔으면(조직 목록에 없음) null(돌아가지 않고 닫기만) */
export function spaceMoveBack(notice, orgs) {
  return notice?.backTo && (orgs ?? []).some((o) => o.id === notice.backTo) ? { space: notice.backTo, ch: notice.backCh ?? null } : null;
}

/** 상단 메뉴별 단락. 전체 = 즐겨찾기 → 내 에이전트 → 외부 에이전트(즐겨찾기는 아래 단락에 다시 넣지 않는다). 빈 단락은 빼고 돌려준다 */
export function agentSections(groups, { filter = 'all', isFav = () => false } = {}) {
  const mine = (g) => !g.ext; const ext = (g) => g.ext;
  const out = filter === 'fav' ? [['fav', groups.filter(isFav)]]
    : filter === 'mine' ? [['mine', groups.filter(mine)]]
    : filter === 'ext' ? [['ext', groups.filter(ext)]]
    : [['fav', groups.filter(isFav)], ['mine', groups.filter((g) => mine(g) && !isFav(g))], ['ext', groups.filter((g) => ext(g) && !isFav(g))]];
  return out.map(([key, list]) => ({ key, list })).filter((s) => s.list.length);
}

// 즐겨찾기 저장 — 조직 행은 기존 에이전트 즐겨찾기(msgr_target_prefs, target_kind 'crew', 조직별 — 데스크톱 레일 '내 에이전트' 별과 같은 행).
// 개인 공간 행은 그 표에 둘 자리가 없어(org_id NOT NULL) 이 기기에만 둔다. pinned = Set('조직id:크루id'), local = Set(크루id)
export const AGENT_FAV_KEY = 'argo-msgr-agent-fav';
export function readAgentFav(store) {
  try { const v = JSON.parse(store?.getItem(AGENT_FAV_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
export function groupIsFav(group, { pinned = new Set(), local = new Set() } = {}) {
  return group.rows.some((r) => (r.org_id ? pinned.has(`${r.org_id}:${r.id}`) : local.has(r.id)));
}
/** 켜기·끄기에 필요한 쓰기 — 서버는 값이 바뀌는 조직 행만(같은 값 다시 쓰기 0), 개인 행은 다음 기기 목록 */
export function favChanges(group, on, { pinned = new Set(), local = new Set() } = {}) {
  const server = group.rows.filter((r) => r.org_id && pinned.has(`${r.org_id}:${r.id}`) !== on).map((r) => ({ org_id: r.org_id, target_kind: 'crew', target_id: r.id, pinned: on }));
  const next = new Set(local);
  for (const r of group.rows) if (!r.org_id) { if (on) next.add(r.id); else next.delete(r.id); }
  return { server, local: next };
}
