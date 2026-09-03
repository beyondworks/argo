// 상주 노드 부트스트랩(부록 I·F3-1, I-4) — 노드 한 대 = 조직 한 개. 관리자가 메신저 조직 카드에서 만든 "노드 연결 코드"로
//  ① 서비스 계정 로그인(이메일·비밀번호는 env로만 — 값을 출력하지 않는다) ② 초대 수락 = 서버가 그 계정을 조직의 서비스 계정으로
//  지정(msgr_accept_invite for_node) ③ 노드 데이터 루트(ARGO_ROOT)에 기기 세션 저장 ④ 조직 회사(ws) 생성·company.json.msgr =
//  { enabled, nodeOrgId } ⑤ 첫 하트비트. 재실행은 멱등(회사가 있으면 재사용). 이후 게이트웨이 폴러가 nodeOrgId로 하트비트를 잇는다.
import { createClient } from '@supabase/supabase-js';
import { existsSync } from 'node:fs';
import { saveDeviceSession, getFreshDeviceSession } from './devicesession.mjs';
import { createCompany, loadCompany, updateCompany, paths } from './workspace.mjs';

/** 조직 슬러그 → 노드 회사 id(`org-<slug>`) — 회사 폴더 이름 규칙(소문자·숫자·하이픈)에 맞춰 세척 */
export const nodeWs = (slug) => `org-${String(slug ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org'}`;

const unwrap = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
const CLIENT = { auth: { persistSession: false, autoRefreshToken: false } };

export async function bootstrapNode({ code, url, anonKey, email, password, lang = 'ko', mkClient = createClient } = {}) {
  if (!code?.trim()) throw new Error('노드 연결 코드가 없습니다(ARGO_NODE_CODE)');
  if (!url || !anonKey) throw new Error('Supabase 공개 설정이 없습니다(NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  let session;
  if (email && password) {
    const r = await mkClient(url, anonKey, CLIENT).auth.signInWithPassword({ email, password });
    if (r.error) throw new Error(`서비스 계정 로그인 실패: ${r.error.message}`);
    session = r.data.session;
  } else {
    const d = await getFreshDeviceSession(); // 이미 저장된 노드 세션(재실행) — 회전은 devicesession이 맡는다
    if (!d) throw new Error('서비스 계정 자격이 없습니다 — ARGO_NODE_EMAIL·ARGO_NODE_PASSWORD 또는 이미 저장된 기기 세션이 필요합니다');
    session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, user: d.user };
  }
  const client = mkClient(url, anonKey, { ...CLIENT, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
  const orgId = unwrap(await client.rpc('msgr_accept_invite', { code: code.trim() }));
  const org = unwrap(await client.from('msgr_orgs').select('id, name, slug, service_user_id').eq('id', orgId).single());
  // 사람용 초대 코드는 수락은 되지만(멤버로 들어감) 서비스 계정이 되지 않는다 — 여기서 정직하게 멈춘다(관리자가 멤버를 정리)
  if (org.service_user_id !== session.user.id) throw new Error('이 코드는 노드용이 아닙니다 — 조직 카드의 "연결 코드 만들기"로 만든 코드를 쓰세요(이 계정은 일반 멤버로 들어갔습니다)');
  await saveDeviceSession({ url, anonKey, session });
  const ws = nodeWs(org.slug);
  if (!existsSync(paths(ws).company)) await createCompany(ws, org.name, '회사 노드', session.user.id, lang);
  await updateCompany(ws, { msgr: { ...((await loadCompany(ws)).msgr ?? {}), enabled: true, nodeOrgId: orgId } });
  unwrap(await client.rpc('msgr_node_heartbeat', { org: orgId }));
  return { orgId, ws, uid: session.user.id, orgName: org.name };
}
