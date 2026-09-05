// 팀 메신저 로컬 개발 시드 — 로컬 Supabase 스택(supabase start)에 사용자 2명·조직·채널·크루 등록을 만든다(개발 전용, 실 프로젝트 금지).
// 사용: E2E_SB_DIR=<supabase 디렉터리> node scripts/msgr-dev-seed.mjs  → 콘솔에 로그인 이메일/비밀번호(로컬 전용)·조직 id 출력.
// 메신저 앱(apps/messenger)의 .env.local에 API_URL/ANON_KEY를 넣고 개발용 비밀번호 로그인으로 들어가 화면을 확인한다.
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const dir = process.env.E2E_SB_DIR;
if (!dir) { console.error('E2E_SB_DIR 필요'); process.exit(2); }
const r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: dir, encoding: 'utf8' });
const env = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
if (/^https:\/\/[a-z0-9]+\.supabase\.co/.test(env.API_URL ?? '')) { console.error('실 프로젝트로 보인다 — 시드 중단'); process.exit(2); }
const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stamp = Date.now().toString(36);
const users = [];
for (const [tag, name] of [['owner', '유건'], ['member', '민수']]) {
  const email = `${tag}-${stamp}@example.test`; const password = `dev-${tag}-${stamp}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (error) throw error;
  const c = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } });
  const s = await c.auth.signInWithPassword({ email, password }); if (s.error) throw s.error;
  users.push({ tag, name, email, password, id: data.user.id, client: c });
}
const [A, B] = users;
const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; };
const org = await q(A.client.from('msgr_orgs').insert({ name: '린 컴퍼니', slug: `lean-${stamp}`, owner_user_id: A.id }).select('id').single());
await q(A.client.from('msgr_org_members').update({ display_name: A.name }).eq('org_id', org.id).eq('user_id', A.id));
const inv = await q(A.client.from('msgr_invites').insert({ org_id: org.id, role: 'member', created_by: A.id }).select('code').single());
await q(B.client.rpc('msgr_accept_invite', { code: inv.code }));
await q(A.client.from('msgr_org_members').update({ display_name: B.name }).eq('org_id', org.id).eq('user_id', B.id));
await admin.from('msgr_org_entitlements').update({ plan: 'team', seats: 10 }).eq('org_id', org.id);
const ch = await q(A.client.from('msgr_channels').insert({ org_id: org.id, kind: 'public', name: 'general', topic: '전체 공지와 잡담', created_by: A.id }).select('id').single());
await q(A.client.from('msgr_channels').insert({ org_id: org.id, kind: 'public', name: 'marketing', topic: '캠페인·콘텐츠', created_by: A.id }));
const crew = await q(A.client.from('msgr_crews').insert({ org_id: org.id, owner_user_id: A.id, ws_id: 'lean-ax-dev', slug: 'seoyun', display_name: '서윤', role_text: '마케터', allow: 'all', last_seen_at: new Date().toISOString() }).select('id').single());
await q(A.client.from('msgr_crews').insert({ org_id: org.id, owner_user_id: A.id, ws_id: 'lean-ax-dev', slug: 'jun', display_name: '준', role_text: '데이터 분석', allow: 'owner' }));
const m1 = await q(B.client.from('msgr_messages').insert({ channel_id: ch.id, author_kind: 'user', author_user_id: B.id, body: '다음 주 캠페인 브리프 초안 공유합니다. @서윤 검토 부탁해요.', mentions: [{ kind: 'crew', id: crew.id }] }).select('id').single());
await q(A.client.from('msgr_messages').insert({ channel_id: ch.id, author_kind: 'crew', crew_id: crew.id, body: '브리프 확인했습니다. **핵심 메시지 3개**로 압축해 정리하겠습니다.\n\n1. 신규 고객 온보딩 7일\n2. 추천 리워드\n3. 팀 플랜 출시', reply_to: m1.id, client_msg_id: `reply:${crew.id}:${m1.id}` }));
const ap = await q(A.client.from('msgr_crew_approvals').insert({ org_id: org.id, channel_id: ch.id, crew_id: crew.id, approval_id: 'ap-dev1', action: '뉴스레터 3,200명 발송', reason: '캠페인 D-7 안내' }).select('id').single());
const card = await q(A.client.from('msgr_messages').insert({ channel_id: ch.id, author_kind: 'crew', crew_id: crew.id, kind: 'approval_card', body: '결재 요청: 뉴스레터 3,200명 발송\n사유: 캠페인 D-7 안내\n(확정은 이 크루의 소유자만 할 수 있습니다)', mentions: [{ kind: 'approval', id: ap.id }], client_msg_id: `ap:${crew.id}:ap-dev1` }).select('id').single());
await q(A.client.from('msgr_crew_approvals').update({ message_id: card.id }).eq('id', ap.id));
console.log(JSON.stringify({ url: env.API_URL, org: org.id, channel: ch.id, users: users.map(({ tag, email, password, id }) => ({ tag, email, password, id })) }, null, 2));
