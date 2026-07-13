import { createCompany } from '../../../src/workspace.mjs';
import { listCompanies } from '../../../src/hub.mjs';
import { applyPreset, PRESETS } from '../../../src/presets.mjs';
import { AUTH_ON, currentUser, tenantDenied } from '../../auth.mjs';

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
  const td = tenantDenied(user); if (td) return td;
  const all = await listCompanies();
  // 인증 on = 내 회사만. 무주(레거시) 회사는 아무에게나 노출하지 않는다 — 최초 소유자 지정은
  // guardCompany의 ARGO_ADOPT_OWNER 게이트로만 처리한다. off = 로컬 전부.
  const companies = AUTH_ON ? all.filter((c) => c.ownerId === user.id) : all;
  return Response.json({
    companies,
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, desc: p.desc })),
  });
}

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
    const td = tenantDenied(user); if (td) return td;
    const { name, owner, preset } = await req.json();
    if (!name?.trim()) return Response.json({ error: '회사 이름이 필요합니다' }, { status: 400 });
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const wsId = `${base || 'co'}-${Date.now().toString(36).slice(-4)}`;
    const company = await createCompany(wsId, name.trim(), owner?.trim() || 'captain', AUTH_ON ? user.id : null);
    if (preset) await applyPreset(wsId, preset); // 즉시 — 정적 카드라 기다림 없음
    // 아하 모먼트 동선 — 프리셋 회사는 첫 크루 채팅으로 직행시켜 시운전이 눈앞에서 도착하게
    const firstCrew = preset ? (PRESETS[preset]?.crews?.[0]?.[1] ?? null) : null;
    return Response.json({ company, firstCrew });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
