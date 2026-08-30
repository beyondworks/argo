import { readAgentCard, saveAgentCard, removeAgentCard, updateAgentMeta } from '../../../../../../src/persona.mjs';
import { guardCompany, langFromCookieHeader } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';

/** 카드 열람 — 카드가 곧 시스템 프롬프트(투명성) + 최근 업무·적용 스킬(크루 프로필). */
export async function GET(req, { params }) {
  // 표시 언어 — 오류 문구를 사용자 화면 언어(argo-lang 쿠키)로 그린다(#333 계약의 기능 라우트 합류)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { md, meta } = await readAgentCard(ws, slug);
    const [{ readEvents, recentTurnsOf }, { listInstalledSkills, loadMcp }, { agentStats }] = await Promise.all([
      import('../../../../../../src/events.mjs'),
      import('../../../../../../src/market.mjs'),
      import('../../../../../../src/billing.mjs'), // agentStats — 금액 집계는 billing 게이트로만
    ]);
    const events = await readEvents(ws, 300).catch(() => []);
    // 최신 8개 판정은 코어(recentTurnsOf) — 이전의 인라인 음수 슬라이스+역순은 최신순 배열에서
    // "가장 오래된 8개"를 집었다(검수 PR #209 실측: 12턴 시드에서 업무1~5 표시). 여긴 표시용 매핑만.
    const recent = recentTurnsOf(events, slug, 8)
      .map((e) => ({ gist: e.gist, ts: e.ts, ok: e.ok !== false, ms: e.ms ?? null }));
    const skills = await listInstalledSkills(ws).catch(() => []);
    const mcp = Object.keys((await loadMcp(ws).catch(() => ({ servers: {} }))).servers ?? {}); // 설치 MCP 이름 — 크루별 범위 편집 UI용
    const stats = await agentStats(ws, slug).catch(() => null);
    return Response.json({ md, meta, recent, skills, mcp, stats });
  } catch (e) {
    // 원인을 가려서 돌려준다. 예전엔 catch가 통째로 삼켜서, 카드는 멀쩡한데 이벤트·스킬 읽기가
    // 실패해도 화면엔 "크루를 찾을 수 없습니다"가 떴다 — 사용자도 우리도 진짜 원인을 못 봤다
    // (실사용 신고 2026-08-02의 진단이 늦어진 이유). 없음은 404, 그 외는 500 + 실제 사유.
    if (e?.code === 'NOT_FOUND') return apiError('crew_not_found', lang);
    if (e?.code === 'BAD_SLUG') return Response.json({ error: String(e.message) }, { status: 400 }); // 경로 이탈 등 — 서버 잘못이 아니다
    const detail = String(e?.message || e);
    return apiError('crew_card_read_failed', lang, detail);
  }
}

export async function PUT(req, { params }) {
  // 표시 언어 — GET과 같은 계약. 원문 편집기는 빈 카드·name 삭제 저장을 막지 않는다(2078행 가드는
  // md === null뿐) — 이 오류들이 카드 패널 setMsg로 그대로 렌더되는 실도달 표면이다.
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { md } = await req.json();
    if (!md?.trim()) return apiError('crew_card_body_required', lang);
    const agent = await saveAgentCard(ws, slug, md);
    return Response.json({ agent });
  } catch (e) {
    // 코어 throw는 기계 코드로 판별한다(문자열 매칭 금지 — E2EE_BAD_CODE 관례)
    if (e?.code === 'NOT_FOUND') return apiError('crew_missing', lang); // stale 패널의 저장(해고 뒤)
    if (e?.code === 'CARD_NAME_REQUIRED') return apiError('crew_card_name_required', lang);
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 신원·범위 수정 — 이름·역할·팀·모델·러너 + 능력 범위(skills/mcp — 빈 값=전체, 'none'=없음, csv=지정만). */
export async function PATCH(req, { params }) {
  // 표시 언어 — GET과 같은 계약(stale 패널의 범위 칩 토글·신원 수정 모달이 이 오류를 렌더)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { name, role, team, model, runner, effort, skills, mcp } = await req.json();
    const meta = await updateAgentMeta(ws, slug, { name, role, team, model, runner, effort, skills, mcp });
    return Response.json({ meta });
  } catch (e) {
    if (e?.code === 'NOT_FOUND') return apiError('crew_missing', lang);
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 해고 — .archive/로 이동(복구 가능). */
export async function DELETE(req, { params }) {
  // 표시 언어 — GET과 같은 계약(해고 실패는 패널에 보인다 — 2026-08-02 실사용 신고 표면)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws, slug } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    await removeAgentCard(ws, slug);
    return Response.json({ ok: true });
  } catch (e) {
    if (e?.code === 'NOT_FOUND') return apiError('crew_missing', lang); // 이미 해고된 크루의 재시도(stale 패널)
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
