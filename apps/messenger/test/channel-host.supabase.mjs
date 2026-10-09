// Browser-only fixture: 채널 관리 판정(channel-host.mjs) — 참여 전 공개 채널을 미리보기로 열었을 때의 설정 시트.
// dm-lifecycle 픽스처의 가짜 서버를 그대로 쓰고(자격 증명 없음, 실제 조직·대화 미접촉) 표만 바꾼다.
// 내 역할은 localStorage 'ch-host-role'(기본 member, owner 면 조직 관리자)로 고른다.
// 띄우기: node node_modules/vite/bin/vite.js --config test/channel-host.config.mjs  →  http://127.0.0.1:5231/test/channel-host.fixture.html
//   (CH_TEST_PORT로 포트, CH_BASELINE_REF=<커밋>으로 그 커밋의 App.jsx 비교). 미참여 채널을 미리보기로 열려면 localStorage 'argo-msgr-last-ch'에 {"org-fixture":"legacy-mine"}을 넣고 새로고침(폰은 검색 → 전체에서 찾기).
//   채널: legacy-mine = 내가 만들었지만 참여한 적 없는 공개 채널 · legacy-admin = 채널 관리자로만 지정된 미참여 공개 채널 · legacy-plain = 남의 미참여 공개 채널 · general = 내가 만들고 참여한 공개 채널.
//   기대: member로 legacy-mine·legacy-admin을 열면 채널 설정이 읽기 전용(+ '참여하면 바꿀 수 있습니다'), 참여하면 편집 가능, owner(조직 관리자)는 미참여여도 편집 가능.
import { supabase as base } from './dm-lifecycle.supabase.mjs';
export * from './dm-lifecycle.supabase.mjs'; // 가져온 모듈이 먼저 실행돼 window.__dmFixture가 이미 있다
const state = window.__dmFixture;
const uid = 'user-me', other = 'user-other', org = 'org-fixture';
const role = (() => { try { return localStorage.getItem('ch-host-role') || 'member'; } catch { return 'member'; } })();
const me = state.tables.msgr_org_members.find((m) => m.user_id === uid);
me.role = role;
me.msgr_orgs.owner_user_id = other; // 조직 소유자는 다른 사람 — 내 역할만 바꿔 본다
const channel = (id, name, extra = {}) => ({ id, org_id: org, kind: 'public', name, created_by: other, archived_at: null, admin_user_ids: [], crew_memory: true, personal_crews: true, ...extra });
state.tables.msgr_channels.push(
  channel('legacy-mine', 'Legacy Public', { created_by: uid }), // 9/16 전에 내가 만든 공개 채널 — 참여 행 없음
  channel('legacy-admin', 'Legacy Admin Channel', { admin_user_ids: [uid] }), // 내가 채널 관리자로 지정됐지만 참여한 적 없는 공개 채널
  channel('legacy-plain', 'Legacy Plain'), // 남이 만든 공개 채널 — 나는 아무것도 아니다
);
// 기본 'general'(Fixture General)은 내가 만들고 참여한 공개 채널 — 참여 중인 생성자.
window.__chHost = { role };
// 둘러보기·참여 — 가져온 가짜 서버에는 없는 두 호출(참여 행을 넣으면 사이드바 목록이 바뀐다)
const joinedIds = () => new Set(state.tables.msgr_channel_members.filter((m) => m.member_kind === 'user' && m.member_id === uid).map((m) => m.channel_id));
export const supabase = {
  ...base,
  rpc: async (name, args) => {
    if (name === 'msgr_browse_channels') { state.calls.push({ rpc: name, args }); return { data: state.tables.msgr_channels.filter((c) => c.kind === 'public' && !joinedIds().has(c.id)).map((c) => ({ id: c.id, name: c.name, members: 0 })), error: null }; }
    if (name === 'msgr_join_channel') { state.calls.push({ rpc: name, args }); state.tables.msgr_channel_members.push({ channel_id: args.ch, member_kind: 'user', member_id: uid, added_by: uid }); return { data: null, error: null }; }
    return base.rpc(name, args);
  },
};
