// Browser-only fixture: U2 G3·G4(2026-10-14) — 방장 '내보내기'와 주인 '관리자가 내보냄' 안내.
// dm-lifecycle 가짜 서버를 그대로 쓰고(자격 증명 없음, 실제 조직·대화 미접촉) 표만 더한다.
// 띄우기: node node_modules/vite/bin/vite.js --config test/u2-eject.config.mjs  →  http://127.0.0.1:5241/test/u2-eject.fixture.html (U2_TEST_PORT로 포트)
//   나 = Fixture General을 만든 방장. 동료(user-other)의 개인 에이전트 'Colleague Agent'가 그 채널에 있다 → 참여 패널 행 '…'에 '내보내기'.
//   내 에이전트 'Fixture New Agent'는 관리자가 #Fixture General에서 내보낸 기록이 있다 → 에이전트 카드에 안내 한 줄.
import { supabase as base } from './dm-lifecycle.supabase.mjs';
export * from './dm-lifecycle.supabase.mjs';
const state = window.__dmFixture;
const now = new Date().toISOString();
state.tables.msgr_crews.push({ id: 'crew-colleague', org_id: 'org-fixture', owner_user_id: 'user-other', slug: 'colleague', display_name: 'Colleague Agent', hosting: 'local', status: 'active', last_seen_at: now, created_at: now, allow: 'all' });
state.tables.msgr_channel_members.push({ channel_id: 'general', member_kind: 'user', member_id: 'user-other' }, { channel_id: 'general', member_kind: 'crew', member_id: 'crew-colleague' });
state.tables.msgr_crew_dispatch_log = [{ id: 1, channel_id: 'general', crew_id: 'crew-new', event: 'removed_by_admin', actor: 'user-other', at: new Date(Date.now() - 3 * 3600_000).toISOString() }];
export const supabase = {
  ...base,
  rpc: async (name, args) => {
    if (name === 'msgr_crew_leave_channel') {
      state.calls.push({ rpc: name, args });
      const crew = state.tables.msgr_crews.find((c) => c.id === args.crew);
      state.tables.msgr_channel_members = state.tables.msgr_channel_members.filter((m) => !(m.channel_id === args.ch && m.member_kind === 'crew' && m.member_id === args.crew));
      state.tables.msgr_crew_dispatch_log.push({ id: state.tables.msgr_crew_dispatch_log.length + 1, channel_id: args.ch, crew_id: args.crew, event: crew?.owner_user_id === 'user-me' ? 'released_by_owner' : 'removed_by_admin', actor: 'user-me', at: new Date().toISOString() });
      return { data: 'removed', error: null };
    }
    return base.rpc(name, args);
  },
};
