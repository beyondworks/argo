// 로그인 뒤 서버의 배치를 가져온다 — 아직 안 보낸 변경이 있는 배치는 이 기기 값을 지킨다(로컬 우선).
import { getClient } from './supabase.js';
import { SPACES, ME } from './session.js';
import { update } from './store.js';
import { outbox } from './sync.js';

export async function pullLayouts() {
  const sb = await getClient();
  if (!sb) return;
  const orgs = SPACES.filter((s) => s.kind === 'org');
  const [mine, shared] = await Promise.all([
    sb.from('office_user_layouts').select('space_key, surface, prefs').eq('user_id', ME.id).eq('space_key', 'me'),
    orgs.length ? sb.from('office_space_layouts').select('org_id, surface, layout').in('org_id', orgs.map((o) => o.id)) : { data: [] },
  ]);
  const next = {};
  for (const r of mine.data ?? []) next[`${r.surface}:me`] = r.prefs;
  for (const r of shared.data ?? []) { const o = orgs.find((x) => x.id === r.org_id); if (o) next[`${r.surface}:${o.key}`] = r.layout; }
  const keep = Object.entries(next).filter(([k]) => !outbox.has(`layout:${k}`));
  if (keep.length) update((s) => ({ layouts: { ...s.layouts, ...Object.fromEntries(keep) } }));
}
