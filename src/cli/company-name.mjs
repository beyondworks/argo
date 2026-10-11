// argo CLI 회사 이름 ↔ 메신저 조직 이름(사용자 제보 2026-10-11 — "서버에서 설정한 조직명과 메신저에서 로그인한 조직명이 다르게 나온다").
// 회사(company.json — 에이전트·기억)와 메신저 조직(msgr_orgs — 사람·채널)은 따로 저장되는 다른 것이다. 메신저로 먼저 가입한 사용자가
// 서버에서 argo를 처음 실행하면 CLI가 조직을 모른 채 새 회사 이름을 따로 받았고, 상주가 그 회사의 에이전트를 조직에 파견해 이름이 갈렸다.
// 여기서는 ① 새 회사 이름의 기본값을 내 조직 이름으로 ② 회사에 연결된 조직 이름을 보여 주고 ③ CLI에서 회사 이름을 바꾸게 한다.
// 부하: 새 회사를 만들 때 읽기 1건, status·run 시작 때 읽기 1건(각 3초 상한). 주기 호출·DB 쓰기 없음(이름 바꾸기는 company.json만).
// 노드 회사(msgr-node.mjs)는 처음부터 조직 이름으로 만들어진다 — 같은 규칙을 일반 로그인 경로에 맞춘 것.

import { termSafe } from './ui.mjs';

export { termSafe };
// 남이 정할 수 있는 이름(조직 이름은 그 조직의 다른 관리자가, 회사 이름은 다른 기기·Storage가) — 터미널 제어 문자를 지운 뒤 비교·출력·저장한다(보안 점검 #952)
const norm = (s) => termSafe(s).normalize('NFC').trim();
const LINKED = ['active', 'paused']; // 파견 중인 행 — 해제한 행(detached·available)은 연결로 보지 않는다
/** 조회 상한 — 안내용 읽기가 업그레이드 중 argo status(install.sh·install.ps1)나 첫 실행을 붙잡지 않게(분리 검수 #952 MEDIUM-2, autoEnableMsgr와 같은 3초) */
export const ORG_READ_TIMEOUT_MS = 3000;
/** 회사 이름 상한 — 앱(PUT /api/companies/[ws])은 상한이 없어 CLI는 80자(분리 검수 #952 LOW-4) */
export const COMPANY_NAME_MAX = 80;
const RAW_CTRL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/; // 입력 거절용 — 탭·줄바꿈도 이름에는 쓰지 않는다

/** 상한 안에 끝나지 않으면 오류 — 요청은 abortSignal로 끊는다(빌더가 지원할 때). */
async function limited(builder, ms) {
  const q = typeof builder?.abortSignal === 'function' ? builder.abortSignal(AbortSignal.timeout(ms)) : builder;
  let timer;
  try { return await Promise.race([q, new Promise((_, rej) => { timer = setTimeout(rej, ms, new Error(`timeout ${ms}ms`)); })]); }
  finally { clearTimeout(timer); }
}

/** 데이터 폴더(ARGO_ROOT)의 기기 세션으로 읽기 클라이언트 → { client, uid } | null. 토큰을 회전하지 않는다(디스크 값만 읽음, 분리 검수 #952 MEDIUM-2) —
    만료가 1분 안이거나 지났으면 null(안내 줄을 생략한다). 회전은 상주·로그인 경로가 맡는다. */
export async function readerSession({ load, mk, now = Date.now } = {}) {
  const read = load ?? (await import('../devicesession.mjs')).loadDeviceSession;
  const sess = read();
  if (!sess?.access_token || !sess.user?.id || !sess.url || !sess.anonKey) return null;
  if ((Number(sess.expires_at) || 0) * 1000 - now() < 60_000) return null;
  const create = mk ?? (await import('@supabase/supabase-js')).createClient;
  const client = create(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sess.access_token}` } } });
  return { client, uid: sess.user.id };
}

/** 새 회사 이름 후보 — 내가 속한 메신저 조직 이름(나간 조직·삭제 예정·손님으로 든 조직 제외, 같은 이름은 하나로). 읽기 1건(3초 상한). 오류는 던진다(호출자가 종전 질문으로).
    손님 조직은 남의 조직이라 내 회사 이름으로 제안하지 않는다(총괄 결정, 분리 검수 #952 LOW-6). */
export async function myOrgNames(c, { timeoutMs = ORG_READ_TIMEOUT_MS } = {}) {
  const { data, error } = await limited(c.client.from('msgr_org_members').select('role, org:msgr_orgs(name, deleted_at)').eq('user_id', c.uid).is('removed_at', null), timeoutMs);
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).filter((m) => m?.org && !m.org.deleted_at && m.role !== 'guest').map((m) => norm(m.org.name)).filter(Boolean))];
}

/** 회사별로 이 회사 에이전트가 파견된 조직 이름 → { [wsId]: [이름…] } — 읽기 1건(3초 상한, 회사가 없으면 0건). 오류는 던진다. */
export async function linkedOrgNames(c, wsIds, { timeoutMs = ORG_READ_TIMEOUT_MS } = {}) {
  if (!wsIds?.length) return {};
  const { data, error } = await limited(c.client.from('msgr_crews').select('ws_id, org:msgr_orgs(name, deleted_at)')
    .eq('owner_user_id', c.uid).in('ws_id', wsIds).in('status', LINKED).not('org_id', 'is', null), timeoutMs); // 내 행만, 개인 공간 행(org NULL)은 조직이 아니다
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
  const safe = [...new Set(orgs.map(norm).filter(Boolean))]; // 호출자가 정리하지 않은 값이 와도 프롬프트·기본값에 제어 문자가 들어가지 않게
  if (safe.length === 1) return norm(await ask(T.newCompanyDefault(safe[0]))) || safe[0];
  if (safe.length > 1) {
    const i = await choose(T.newCompanyPick, [...safe, T.newCompanyOther]);
    if (i >= 0 && i < safe.length) return safe[i];
  }
  return norm(await ask(T.newCompany));
}

/** status·run 안내 줄 — 연결된 조직이 없으면 말하지 않는다. 회사 하나면 조직 이름만, 여럿이면 "회사 → 조직". 어떤 회사든 이름이 연결된 조직 중 어느 것과도 다르면 rename 안내 한 줄. */
export function orgNoticeLines(companies, linked, T) {
  const rows = (companies ?? []).map((c) => ({ c, orgs: [...new Set((linked?.[c.id] ?? []).map(norm).filter(Boolean))] })).filter((r) => r.orgs.length); // 출력 직전에도 정리(호출자 무관)
  if (!rows.length) return [];
  const one = (companies ?? []).length === 1;
  const lines = [T.orgLinked(one ? rows[0].orgs.join(', ') : rows.map((r) => `${norm(r.c.name)} → ${r.orgs.join(', ')}`).join(' · '))];
  if (rows.some((r) => !r.orgs.includes(norm(r.c.name)))) lines.push(T.orgMismatch);
  return lines;
}

/** 회사 이름 바꾸기 — company.json의 name만(앱 PUT /api/companies/[ws]와 같이 앞뒤 공백 제거·빈 이름 거절).
    제어 문자·줄바꿈이 든 입력과 80자 넘는 이름은 거절(code 'invalid'·'long'), 지금 이름과 같으면 쓰지 않는다(changed:false — 불필요한 동기화 업로드 없음).
    동기화는 상주가 파일 변경으로 올린다. → { from, to, changed } */
export async function renameCompany(wsId, name, { update, load } = {}) {
  const raw = String(name ?? '');
  if (RAW_CTRL.test(raw) || raw.includes('\x1b')) throw Object.assign(new Error('invalid company name'), { code: 'invalid' });
  const to = raw.normalize('NFC').trim();
  if (!to) throw Object.assign(new Error('empty company name'), { code: 'empty' });
  if ([...to].length > COMPANY_NAME_MAX) throw Object.assign(new Error('company name too long'), { code: 'long' });
  const wsMod = load && update ? null : await import('../workspace.mjs');
  const cur = await (load ?? wsMod.loadCompany)(wsId);
  const from = norm(cur?.name);
  if ((cur?.name ?? '') === to) return { from, to, changed: false };
  await (update ?? wsMod.updateCompany)(wsId, () => ({ name: to }));
  return { from, to, changed: true };
}
