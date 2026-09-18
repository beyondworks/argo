// 다른 공간(보고 있지 않은 조직·개인 공간)의 새 글 — 안 읽음 합계와 알림 판단(유건 실측 2026-09-18: "개인, 조직 각각 페이지에서 교차되는 메시지 확인 안 됨").
// 순수 함수 + supabase 클라이언트 주입 — 테스트는 가짜 클라이언트로 서버 기능 유무(라이브 적용 전·후)를 모두 돈다(test/cross-space.test.mjs).
export const PERSONAL_KEY = 'personal';
export const spaceKey = (orgId) => orgId ?? PERSONAL_KEY;

/** 방송이 어느 공간의 글인가 — org:<id> 토픽이면 그 조직, u:<나> 토픽이면 payload.org_id(null = 개인 공간). */
export const spaceOf = (payload, topicOrg) => (topicOrg !== undefined ? topicOrg : payload?.org_id ?? null);

/** 같은 글이 두 토픽으로 올 수 있다(개인 방: dm:<채널> + u:<나>) — 처음 본 id만 true. 기억은 최근 cap개. */
export function seenOnce(seen, id, cap = 500) {
  if (id == null) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > cap) seen.delete(seen.values().next().value);
  return true;
}

/** 공간별 안 읽음 { [공간]: { n, mention } }. 서버 합계(msgr_unread_totals — 음소거 제외)가 있으면 한 번에,
    없으면(마이그레이션 라이브 적용 전) 공간마다 기존 msgr_unread로 세어 합친다(음소거 제외는 여기서 — 독 배지와 같은 규칙). */
export async function loadSpaceTotals(sb, orgIds, muted = new Set()) {
  // supabase-js 빌더는 then만 있는 thenable이다(catch 없음 — 실측) — Promise.resolve로 감싸야 실패가 합계 전체를 죽이지 않는다
  const r = await Promise.resolve(sb.rpc('msgr_unread_totals')).catch((error) => ({ error }));
  if (!r?.error && Array.isArray(r?.data)) {
    return { source: 'rpc', totals: Object.fromEntries(r.data.map((x) => [spaceKey(x.org_id), { n: x.n || 0, mention: x.mention || 0 }])) };
  }
  const totals = {};
  await Promise.all([...orgIds, null].map(async (org) => {
    const { data } = await Promise.resolve(sb.rpc('msgr_unread', { org })).catch(() => ({ data: null }));
    let n = 0; let mention = 0;
    for (const row of data ?? []) if (!muted.has(row.channel_id)) { n += row.n || 0; mention += row.mention || 0; }
    if (n) totals[spaceKey(org)] = { n, mention };
  }));
  return { source: 'fallback', totals };
}

/** 독 배지 = 보고 있는 공간(채널별 안 읽음 — 가장 최신) + 다른 공간 합계. 음소거 채널은 뺀다. */
export function badgeTotal({ current = {}, currentKey, muted = new Set(), totals = {} }) {
  let sum = 0;
  for (const [id, u] of Object.entries(current)) if (!muted.has(id)) sum += u?.n || 0;
  for (const [key, u] of Object.entries(totals)) if (key !== currentKey) sum += u?.n || 0;
  return sum;
}

/** 알림 전 확인 — 그 글을 **내 권한(RLS)으로 읽을 수 있을 때만** 알린다. 조직 토픽은 조직 전원이 들어서, 내가 없는 방의 방송에도
    "사진·파일을 보냈습니다" 알림이 뜨던 결함(실측 2026-09-18)을 여기서 닫는다. 알림 제목에 쓸 채널·작성자 이름과 본문도 이 조회로 채운다
    (다른 공간 글은 지금 불러 둔 목록에 없다). 못 읽으면 null. */
export async function readableForNotify(sb, payload, orgId) {
  if (!payload?.id) return null;
  const { data: m } = await sb.from('msgr_messages').select('id, body, channel_id, msgr_channels(name, kind)')
    .eq('id', payload.id).is('deleted_at', null).maybeSingle().then((r) => r, () => ({ data: null }));
  if (!m) return null;
  let author = null;
  if (payload.author_kind === 'crew' && payload.crew_id) {
    author = (await sb.from('msgr_crews').select('display_name').eq('id', payload.crew_id).maybeSingle().then((r) => r, () => ({ data: null }))).data?.display_name ?? null;
  } else if (payload.author_user_id) {
    const q = orgId
      ? sb.from('msgr_org_members').select('display_name').eq('org_id', orgId).eq('user_id', payload.author_user_id)
      : sb.from('msgr_profiles').select('display_name').eq('user_id', payload.author_user_id);
    author = (await q.maybeSingle().then((r) => r, () => ({ data: null }))).data?.display_name ?? null;
  }
  return { ...payload, body: m.body ?? '', channel_name: m.msgr_channels?.name ?? '', channel_kind: m.msgr_channels?.kind ?? null, author_name: author };
}

/** 거절될 수 있는 구독(서버 적용 전의 u:<나>) — 오류로 끝나면 그 채널을 걷고 min부터 두 배씩(최대 max) 기다렸다 다시 붙는다.
    붙으면 간격을 처음으로 되돌린다. realtime-js의 자체 재시도(수 초 간격)가 거절을 끝없이 되풀이해 Realtime 로그를 채우던 것을 막는다.
    돌려준 함수로 멈춘다(예약된 재시도와 채널을 모두 걷는다). */
export function joinWithBackoff(sb, make, { min = 60_000, max = 600_000, timer = setTimeout, clear = clearTimeout } = {}) {
  let stopped = false; let ch = null; let t = null; let delay = min;
  const drop = (c) => { Promise.resolve(sb.removeChannel(c)).catch(() => {}); };
  const join = () => {
    if (stopped) return;
    const c = ch = make();
    c.subscribe((status) => {
      if (status === 'SUBSCRIBED') { delay = min; return; }
      if (status !== 'CHANNEL_ERROR' || stopped || ch !== c) return;
      ch = null; drop(c);
      t = timer(join, delay); delay = Math.min(delay * 2, max);
    });
  };
  join();
  return () => { stopped = true; clear(t); if (ch) drop(ch); ch = null; };
}
