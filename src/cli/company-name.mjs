// argo CLI 회사 이름 ↔ 메신저 조직 이름(사용자 제보 2026-10-11 — "서버에서 설정한 조직명과 메신저에서 로그인한 조직명이 다르게 나온다").
// 회사(company.json — 에이전트·기억)와 메신저 조직(msgr_orgs — 사람·채널)은 따로 저장되는 다른 것이다. 메신저로 먼저 가입한 사용자가
// 서버에서 argo를 처음 실행하면 CLI가 조직을 모른 채 새 회사 이름을 따로 받았고, 상주가 그 회사의 에이전트를 조직에 파견해 이름이 갈렸다.
// 여기서는 ① 새 회사 이름의 기본값을 내 조직 이름으로 ② 회사에 연결된 조직 이름을 보여 주고 ③ CLI에서 회사 이름을 바꾸게 한다.
// 부하: 새 회사를 만들 때 읽기 1건, status·run 시작 때 읽기 1건. 주기 호출·DB 쓰기 없음(이름 바꾸기는 company.json만).
// 노드 회사(msgr-node.mjs)는 처음부터 조직 이름으로 만들어진다 — 같은 규칙을 일반 로그인 경로에 맞춘 것.

const norm = (s) => String(s ?? '').normalize('NFC').trim();
const LINKED = ['active', 'paused']; // 파견 중인 행 — 해제한 행(detached·available)은 연결로 보지 않는다

/** 데이터 폴더(ARGO_ROOT)의 기기 세션으로 읽기 클라이언트 → { client, uid } | null(로그인 없음). 회전은 getFreshDeviceSession의 프로세스 간 잠금이 맡는다. */
export async function readerSession({ fresh, mk } = {}) {
  const getFresh = fresh ?? (await import('../devicesession.mjs')).getFreshDeviceSession;
  const sess = await getFresh();
  if (!sess?.access_token || !sess.user?.id || !sess.url || !sess.anonKey) return null;
  const create = mk ?? (await import('@supabase/supabase-js')).createClient;
  const client = create(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sess.access_token}` } } });
  return { client, uid: sess.user.id };
}

/** 내가 속한 메신저 조직 이름(나간 조직·삭제 예정 조직 제외, 같은 이름은 하나로) — 읽기 1건. 오류는 던진다(호출자가 종전 질문으로). */
export async function myOrgNames(c) {
  const { data, error } = await c.client.from('msgr_org_members').select('org:msgr_orgs(name, deleted_at)').eq('user_id', c.uid).is('removed_at', null);
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).filter((m) => m?.org && !m.org.deleted_at).map((m) => norm(m.org.name)).filter(Boolean))];
}

/** 회사별로 이 회사 에이전트가 파견된 조직 이름 → { [wsId]: [이름…] } — 읽기 1건(회사가 없으면 0건). 오류는 던진다. */
export async function linkedOrgNames(c, wsIds) {
  if (!wsIds?.length) return {};
  const { data, error } = await c.client.from('msgr_crews').select('ws_id, org:msgr_orgs(name, deleted_at)')
    .eq('owner_user_id', c.uid).in('ws_id', wsIds).in('status', LINKED).not('org_id', 'is', null); // 개인 공간 행(org NULL)은 조직이 아니다
  if (error) throw new Error(error.message);
  const out = {};
  for (const r of data ?? []) {
    const name = r?.org && !r.org.deleted_at ? norm(r.org.name) : '';
    if (!name) continue;
    const list = (out[r.ws_id] ??= []);
    if (!list.includes(name)) list.push(name);
  }
  return out;
}

/** 새 회사 이름 고르기 — 조직 하나: "새 회사 이름 [조직]:" Enter면 그 이름 · 여럿: 번호(마지막 줄 = 직접 입력, 잘못 친 번호도 직접 입력) · 없음: 종전 질문. */
export async function chooseNewCompanyName({ orgs = [], ask, choose, T }) {
  if (orgs.length === 1) return (await ask(T.newCompanyDefault(orgs[0]))) || orgs[0];
  if (orgs.length > 1) {
    const i = await choose(T.newCompanyPick, [...orgs, T.newCompanyOther]);
    if (i >= 0 && i < orgs.length) return orgs[i];
  }
  return ask(T.newCompany);
}

/** status·run 안내 줄 — 연결된 조직이 없으면 말하지 않는다. 회사 하나면 조직 이름만, 여럿이면 "회사 → 조직". 어떤 회사든 이름이 연결된 조직 중 어느 것과도 다르면 rename 안내 한 줄. */
export function orgNoticeLines(companies, linked, T) {
  const rows = (companies ?? []).map((c) => ({ c, orgs: linked?.[c.id] ?? [] })).filter((r) => r.orgs.length);
  if (!rows.length) return [];
  const one = (companies ?? []).length === 1;
  const lines = [T.orgLinked(one ? rows[0].orgs.join(', ') : rows.map((r) => `${norm(r.c.name)} → ${r.orgs.join(', ')}`).join(' · '))];
  if (rows.some((r) => !r.orgs.includes(norm(r.c.name)))) lines.push(T.orgMismatch);
  return lines;
}

/** 회사 이름 바꾸기 — company.json의 name만(앱 PUT /api/companies/[ws]와 같은 규칙: 앞뒤 공백 제거·빈 이름 거절). 동기화는 상주가 파일 변경으로 올린다. */
export async function renameCompany(wsId, name, { update } = {}) {
  const to = norm(name);
  if (!to) throw Object.assign(new Error('empty company name'), { code: 'empty' });
  const doUpdate = update ?? (await import('../workspace.mjs')).updateCompany;
  let from = '';
  await doUpdate(wsId, (cur) => { from = cur?.name ?? ''; return { name: to }; });
  return { from, to };
}
