import { createCompany } from '../../../src/workspace.mjs';
import { listCompanies } from '../../../src/hub.mjs';
import { applyPreset, PRESETS, presetFor } from '../../../src/presets.mjs';
import { seedRunnerCreds } from '../../../src/runners.mjs';
import { AUTH_ON, currentUser, tenantDenied } from '../../auth.mjs';

export async function GET(req) {
  const user = await currentUser();
  if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
  const td = tenantDenied(user); if (td) return td;
  const all = await listCompanies();
  // 인증 on = 내 회사만. 무주(레거시) 회사는 아무에게나 노출하지 않는다 — 최초 소유자 지정은
  // guardCompany의 ARGO_ADOPT_OWNER 게이트로만 처리한다. off = 로컬 전부.
  // 게스트(id 'local')는 주인 없는(로컬 생성) 회사만 — 계정 귀속 회사는 로그인해야 보인다(guardCompany 대칭)
  const companies = AUTH_ON
    ? all.filter((c) => (user.id === 'local' ? !c.ownerId : c.ownerId === user.id))
    : all;
  // 프리셋 picker 라벨 — 클라이언트 UI 언어(?lang=en)를 따른다. presetFor가 en 미비 키를 ko로 폴백.
  const lang = new URL(req.url).searchParams.get('lang') === 'en' ? 'en' : 'ko';
  return Response.json({
    companies,
    presets: Object.keys(PRESETS).map((key) => {
      const p = presetFor(key, lang);
      return { key, label: p.label, desc: p.desc };
    }),
  });
}

export async function POST(req) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
    const td = tenantDenied(user); if (td) return td;
    const { name, owner, preset, lang } = await req.json();
    if (!name?.trim()) return Response.json({ error: '회사 이름이 필요합니다' }, { status: 400 });
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const wsId = `${base || 'co'}-${Date.now().toString(36).slice(-4)}`;
    // lang = 클라이언트 UI 언어(argo-lang)를 시드로 — 신규 회사의 시스템 언어. createCompany가 ko/en으로 정규화.
    // 게스트(id 'local')가 만든 회사는 주인 없음(null) — 나중에 로그인하면 클레임으로 계정 귀속
    const company = await createCompany(wsId, name.trim(), owner?.trim() || 'captain', AUTH_ON && user.id !== 'local' ? user.id : null, lang);
    // 온보딩에서 연결한 러너 자격을 새 회사로 시드 — "로그인 → 러너 연결 → 회사 만들기" 순서의 접합점.
    // 회사를 만든 그 사용자(user.id, 로컬 모드 'local')의 계정 스코프에서만 복사한다(교차 사용자 시드 차단).
    // 시드 실패가 회사 생성 자체를 막지 않는다(자격은 설정에서 언제든 다시 연결 가능).
    await seedRunnerCreds(wsId, user.id).catch(() => {});
    // company.lang = createCompany가 정규화한 시스템 언어('ko'|'en') — 프리셋 카드·루틴이 이 언어를 따른다.
    if (preset) await applyPreset(wsId, preset, company.lang); // 즉시 — 정적 카드라 기다림 없음
    // 아하 모먼트 동선 — 프리셋 회사는 첫 크루 채팅으로 직행시켜 시운전이 눈앞에서 도착하게(en은 en 슬러그로)
    const firstCrew = preset ? (presetFor(preset, company.lang)?.crews?.[0]?.[1] ?? null) : null;
    return Response.json({ company, firstCrew });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
