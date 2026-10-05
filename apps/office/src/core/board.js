// 기록판 — 메신저 행(msgr_*)을 오피스 화면 모양으로 바꾼다(순수 함수). 가져오기는 pull.js, 규칙은 test/board.test.mjs.
// 모양은 예시 데이터(data/sample.js)와 같게 둬서 화면 코드는 출처를 몰라도 된다.

const LINE = /^- (\d\d:\d\d) · \*\*(.+?)\*\*(?: ← ([^:]+): (.*?))? → (.*)$/;

/** 크루 일지 본문(트리거 msgr_channel_journal이 쌓는 줄) → 항목들. 형식이 다른 줄은 버린다 */
export function parseJournal(body) {
  return String(body ?? '').split('\n').map((l) => LINE.exec(l.trim())).filter(Boolean)
    .map(([, time, crew, who, ask, text]) => ({ time, crew, who: who ?? null, ask: ask ?? null, text }));
}

const txt = (s) => { const t = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim(); return t ? [{ type: 'text', text: t }] : undefined; };
const para = (s) => { const c = txt(s); return c ? { type: 'paragraph', content: c } : { type: 'paragraph' }; };

/** 공용 문서 마크다운 → 편집기 문서 모양(제목·글머리 목록·문단). HTML 문자열은 만들지 않는다(화면은 DocView로만 그린다) */
export function mdToDoc(md) {
  const out = [];
  let list = null;
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line), li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { (list ??= (out.push({ type: 'bulletList', content: [] }), out.at(-1))).content.push({ type: 'listItem', content: [para(li[1])] }); continue; }
    list = null;
    if (!line.trim()) continue;
    if (h) { const c = txt(h[2]); out.push(c ? { type: 'heading', attrs: { level: h[1].length }, content: c } : { type: 'heading', attrs: { level: h[1].length } }); continue; }
    out.push(para(line));
  }
  return { type: 'doc', content: out };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null); // payload는 검증 없는 jsonb — 문자열만 화면에 싣는다
/** 결재 한 줄 핵심(유건 9/30 #7) — 에이전트가 적은 목적(purpose)·할 일(task), 없으면 null(화면은 요청 원문 앞부분) */
export const approvalHead = (plain) => str(plain?.purpose) || str(plain?.task);

export const AWAY_MS = 90_000; // 접속 판정 — 메신저와 같은 90초(apps/messenger App.jsx AWAY_MS), 받아 온 때 기준(presence-clock.mjs)
const isCopy = (slug) => /\.conflict-/.test(slug ?? ''); // 동기화 충돌 사본 — 메신저 mention-candidates.mjs isCopyCrew와 같은 판정
const agentOf = (r) => (r?.owner_user_id && r.ws_id && r.slug ? `${r.owner_user_id}|${r.ws_id}|${r.slug}` : null); // 같은 에이전트(crew-face.mjs agentKey와 같은 세 값)

/** 결재 버튼을 보일지(화면용) — 메신저 approval-display.js approvalDecider와 같은 판정, 최종은 서버(RLS msgr_approvals_decide = msgr_can_decide).
 *  꼭 확인(high)은 정책의 결재권자(기본 관리자, 'owner'면 크루 주인, 'approvers'면 관리자와 지정 결재권자 — 손님 제외), 그 밖은 크루 주인.
 *  크루 주인을 모르면(목록에 없음) 버튼을 띄우고, 정책을 못 읽었으면(policy undefined) 서버에 맡긴다(true) */
export function canDecideAp(ap, { me, role, owner, policy }) {
  if (policy === undefined) return true;
  const mode = policy?.approval_high_by ?? 'admin';
  if (ap.risk !== 'high' || mode === 'owner') return owner === undefined || owner === me;
  return role === 'owner' || role === 'admin' || (mode === 'approvers' && role !== 'guest' && (policy?.approver_user_ids ?? []).includes(me));
}
/** 결재 id 집합 — 조직 정책은 한 번 읽어 넘긴다(policies null = 읽기 실패 → 서버에 맡긴다) */
export function decidableSet(approvals, { me, crews, orgs, policies }) {
  const owner = new Map(crews.map((c) => [c.id, c.owner_user_id])), role = new Map(orgs.map((o) => [o.id, o.role]));
  const pol = policies && new Map(policies.map((p) => [p.org_id, p]));
  return new Set(approvals.filter((a) => canDecideAp(a, { me, role: role.get(a.org_id), owner: owner.has(a.crew_id) ? owner.get(a.crew_id) : undefined, policy: pol ? pol.get(a.org_id) ?? null : undefined })).map((a) => a.id));
}

/** 결정하려는 결재의 지금 상태(CX-10) → 안내. pending이면 null(그대로 결정), 이미 정해졌으면 { key: 'ap.already', result }, 행이 없으면(지워짐·권한 밖) { key: 'ap.gone' }.
 *  메신저에서 이미 정한 결재를 오피스에서 누르면 '승인했습니다' 뒤 '권한 없음'이 뜨던 것을 결정 전·거절 뒤 같은 판정으로 바로잡는다 */
export const apStale = (status) => (status === 'pending' ? null : status === 'approved' || status === 'rejected' ? { key: 'ap.already', result: status } : { key: 'ap.gone' });

/** rows: { crews, runs, approvals, decisions, files, channels, journals, docs, agents }, orgKey: org_id → 공간 키, decidable: 결재권 있는 결재 id 집합,
 *  looks: 내 크루 행으로 만든 얼굴 지도(메신저 crew-face.mjs agentLooks — 같은 에이전트는 조직이 달라도 같은 얼굴, 유건 2026-10-05). 없으면 자기 행 그대로.
 *  agents: msgr_crews 행(내 조직의 크루 + 내 개인 공간 크루) — 사본 표시(slug)·접속(last_seen_at)·개인 공간 에이전트(org_id NULL, 주인 = me). 없으면(읽기 실패·예시) 그 정보 없이.
 *  at: 받아 온 시각 — 접속은 이 시각 기준으로 판정해 다음에 다시 읽을 때까지 그대로 둔다(메신저 presence-clock.mjs와 같은 규칙) */
export function mapBoard(rows, { orgKey, decidable, looks = null, me = null, at = Date.now() }) {
  const space = (org) => orgKey.get(org) ?? null;
  const ch = new Map((rows.channels ?? []).map((c) => [c.id, c.kind === 'dm' ? 'DM' : c.name]));
  const who = new Map((rows.members ?? []).map((m) => [`${m.org_id}|${m.user_id}`, m.display_name || '']));
  const leading = new Set((rows.runs ?? []).filter((r) => r.status === 'running').map((r) => r.lead_crew_id));
  const asking = new Set((rows.approvals ?? []).map((a) => a.crew_id));
  const raw = new Map((rows.agents ?? []).map((r) => [r.id, r]));
  // 개인 행은 심박을 쓰지 않는다 — 같은 에이전트 조직 행의 가장 늦은 시각을 빌린다(서버 msgr_personal_room_crews와 같은 규칙)
  const orgSeen = new Map();
  for (const r of rows.agents ?? []) { const k = agentOf(r), s = Date.parse(r.last_seen_at ?? ''); if (k && r.org_id != null && s > (orgSeen.get(k) ?? 0)) orgSeen.set(k, s); }
  const online = (r) => { if (!r) return null; const s = Math.max(Date.parse(r.last_seen_at ?? '') || 0, r.org_id == null ? orgSeen.get(agentOf(r)) ?? 0 : 0); return s > 0 && at - s < AWAY_MS; };
  const toCrew = (c, extra) => { const on = online(raw.get(c.id)); return {
    id: c.id, name: c.display_name, role: c.department || c.role_text || '', dept: c.department || '', job: c.role_text || '', owner: c.owner_user_id, space: space(c.org_id), org: c.org_id, face: looks?.get(c.id) ? looks.get(c.id).face : (c.face ?? null), faceSeed: looks?.get(c.id)?.seed ?? c.id, // 얼굴 = faceOf(faceSeed, face)
    status: leading.has(c.id) ? 'work' : asking.has(c.id) ? 'ask' : on === false ? 'off' : 'idle', on, // 꺼져 있음(off)은 접속 시각을 알 때만
    agent: looks?.get(c.id)?.seed ?? c.id, copy: isCopy(raw.get(c.id)?.slug), // agent = 같은 에이전트 묶음 키(내 에이전트는 대표 행 id — 얼굴 지도와 같은 묶음)
    // 좌측 목록 정리(9/30): 주인·쓸 수 있는지(메신저와 같은 판정)·내 고정/순서 — office_crew_list가 없을 때(옛 DB)는 모두 쓸 수 있는 것으로
    ownerName: c.owner_name ?? null, company: !!c.company, access: c.access ?? 'ok', pinned: !!c.pinned, pinPos: c.pin_pos ?? null, sortPos: c.sort_pos ?? null, ...extra,
  }; };
  // 개인 공간 에이전트(9/30 #779) — 주인만 읽는 행(org_id NULL). 내 공간에만 둔다(space 'me' — 조직 목록에는 섞이지 않는다). 쓸 수 있는지는 서버 msgr_instruct_check와 같이 '켜져 있고 내 것'
  const personal = (rows.agents ?? []).filter((r) => r.org_id == null && me && r.owner_user_id === me && r.status === 'active' && !isCopy(r.slug))
    .map((r) => toCrew(r, { space: 'me', org: null, personal: true, hosting: r.hosting ?? 'local' }));
  const crews = [...(rows.crews ?? []).map((c) => toCrew(c)), ...personal];
  const byName = (org, name) => (rows.crews ?? []).find((c) => c.org_id === org && c.display_name === name)?.id ?? null;
  const days = new Map();
  for (const d of rows.journals ?? []) {
    const k = `${d.org_id}|${d.title}`;
    const entries = parseJournal(d.body).map((e) => ({ time: e.time, crew: byName(d.org_id, e.crew), name: e.crew, text: e.text }));
    if (!days.has(k)) days.set(k, { space: space(d.org_id), date: d.title, entries: [] });
    days.get(k).entries.push(...entries);
  }
  return {
    crews,
    work: (rows.runs ?? []).map((r) => ({ id: r.id, space: space(r.org_id), goal: r.goal, lead: r.lead_crew_id, status: r.status, started: r.created_at, channel: ch.get(r.channel_id) ?? '', done: r.completion_criteria ?? null })),
    approvals: (rows.approvals ?? []).map((a) => ({ id: a.id, space: space(a.org_id), crew: a.crew_id, plain: a.reason || a.action, head: approvalHead(a.pl), need: str(a.pl?.need), risk: a.risk, at: a.created_at, channel: ch.get(a.channel_id) ?? '', canDecide: decidable.has(a.id) })),
    decisions: (rows.decisions ?? []).map((d) => ({ id: d.id, space: space(d.org_id), crew: d.crew_id, plain: d.reason || d.action, action: d.action, risk: d.risk ?? null, result: d.status,
      by: who.get(`${d.org_id}|${d.decided_by}`) ?? '', at: d.decided_at, asked: d.created_at ?? null, channel: ch.get(d.channel_id) ?? '' })), // 결정한 사람 = 조직 멤버 이름(9/30: 늘 '—'이던 결함)
    outputs: (rows.files ?? []).map((f) => ({ id: f.id, space: space(f.org_id), name: f.name, crew: f.msg?.crew_id ?? null, channel: ch.get(f.msg?.channel_id) ?? '', bytes: f.bytes, at: f.created_at, path: f.storage_path ?? null, mime: f.mime ?? '' })),
    docs: (rows.docs ?? []).filter((d) => !d.path.startsWith('journal/')).map((d) => ({ id: d.id, space: space(d.org_id), folder: d.path.split('/')[0], title: d.title, path: d.path, updated: d.updated_at, channel: ch.get(d.channel_id) ?? '' })),
    journal: [...days.values()].map((d) => ({ ...d, entries: d.entries.sort((a, b) => a.time.localeCompare(b.time)) })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
