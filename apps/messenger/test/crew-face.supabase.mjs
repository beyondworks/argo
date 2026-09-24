// 에이전트 얼굴(idle·off·override) 캡처용 픽스처 — 인증된 브라우저 전용, 실 클라이언트·자격증명·네트워크 없음.
// dm-lifecycle 픽스처의 크루 둘(idle) 위에 오프라인 크루 하나·저장된 얼굴(override)이 있는 크루 하나를 더한다.
// msgr_crews.face 저장은 dm-lifecycle의 일반 update(op==='update' → Object.assign)가 그대로 처리한다 — 별도 흉내가 필요 없다.
// 놀람(surprise)은 실시간 방송에서만 켜진다 — 이 픽스처에서 재현하려면 대화창에서 @Fixture 크루를 멘션해 글을 보내고 1초 안에 캡처한다.
export { configured, customServer, SB_URL, SB_ANON, q } from './dm-lifecycle.supabase.mjs';
import { supabase } from './dm-lifecycle.supabase.mjs';
export { supabase };

const state = window.__dmFixture;
const nowIso = new Date().toISOString();
const offIso = new Date(Date.now() - 200_000).toISOString(); // AWAY_MS(90s)보다 한참 지남 → off(졸기)
state.tables.msgr_crews.push(
  { id: 'crew-sleepy', org_id: 'org-fixture', owner_user_id: 'user-me', slug: 'fixture-sleepy', display_name: 'Fixture Sleepy', hosting: 'local', status: 'active', last_seen_at: offIso, created_at: offIso, allow: 'all', face: null },
  { id: 'crew-styled', org_id: 'org-fixture', owner_user_id: 'user-me', slug: 'fixture-styled', display_name: 'Fixture Styled', hosting: 'local', status: 'active', last_seen_at: nowIso, created_at: nowIso, allow: 'all', face: { shape: 4, color: 6, eyes: 2 } },
);
state.tables.msgr_channel_members.push(
  { channel_id: 'general', member_kind: 'crew', member_id: 'crew-sleepy' },
  { channel_id: 'general', member_kind: 'crew', member_id: 'crew-styled' },
);
