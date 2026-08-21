import {
  skillCatalogFor, mcpCatalogFor,
  listInstalledSkills, installSkill, removeSkill, saveCustomSkill,
  loadMcp, installMcp, addCustomMcp, removeMcp,
  listHostMcp, importHostMcp, arbitraryMcpBlocked, safeMcpServersForRuntime,
  planSkillInjection,
  connectorCatalogFor, mergeConnectorStatus, connectConnector,
} from '../../../../../src/market.mjs';
import { listConnections, disconnectConnector } from '../../../../../src/connectors.mjs';
import {
  searchRemoteSkills, installRemoteSkill,
  searchRemoteMcp, installRemoteMcp,
  topRemoteSkills, topRemoteMcp, explainItem, warmExplains,
} from '../../../../../src/remote-market.mjs';
import { loadCompany } from '../../../../../src/workspace.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 120; // explain = 모델 1턴

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const u = new URL(req.url);
  const remote = u.searchParams.get('remote');
  const top = u.searchParams.get('top');

  // 추천 — 스킬(skillsmp ★순) / MCP(npm 주간 다운로드순)
  if (top) {
    try {
      const { lang = 'ko' } = await loadCompany(ws).catch(() => ({})); // 회사 시스템 언어 — 없으면 ko 폴백
      const results = top === 'skills' ? await topRemoteSkills() : await topRemoteMcp();
      warmExplains(results, top === 'skills' ? 'skill' : 'mcp', lang); // 백그라운드 — 응답을 막지 않는다
      return Response.json({ results });
    } catch (e) {
      return Response.json({ results: [], error: `추천 목록 로드 실패: ${String(e.message || e)}` });
    }
  }

  // 원격 마켓 검색 — skillsmp / 공식 MCP 레지스트리
  if (remote) {
    const q = u.searchParams.get('q') ?? '';
    try {
      const results = remote === 'skills' ? await searchRemoteSkills(q) : await searchRemoteMcp(q);
      return Response.json({ results });
    } catch (e) {
      return Response.json({ results: [], error: `원격 마켓 연결 실패: ${String(e.message || e)}` });
    }
  }

  // 카탈로그 — 회사 시스템 언어를 따른다(설치 md 본문까지 같은 언어, installSkill과 동일 소스)
  const [skills, mcp, { lang = 'ko' }, connections] = await Promise.all([
    listInstalledSkills(ws), loadMcp(ws), loadCompany(ws).catch(() => ({})), listConnections(ws),
  ]);
  // 이 환경에서 실제 spawn될 서버 집합 — 차단 환경이면 safeMcpServersForRuntime가 미검증 command를 걸러낸다.
  // 설치 목록엔 있지만 여기 없는 서버 = "설치됨" 표시만 되고 런타임에 조용히 제거됨(거짓 유효). 그걸 정직하게 표기한다.
  const runnable = safeMcpServersForRuntime(mcp.servers ?? {});
  return Response.json({
    skillCatalog: skillCatalogFor(lang).map(({ md, ...rest }) => ({ ...rest, preview: md.slice(0, 200) })),
    mcpCatalog: mcpCatalogFor(lang),
    // 커넥터 = 카탈로그(정의) × 이 회사의 연결 상태. 카탈로그에서 내려간 뒤에도 토큰이 남은 연결은
    // orphan 행으로 남아 해제 버튼이 사라지지 않는다(mergeConnectorStatus).
    connectors: mergeConnectorStatus(connectorCatalogFor(lang), connections),
    // 주입 상태 — loadSkills와 같은 규칙(planSkillInjection)으로 계산해 "설치됨인데 크루는
    // 모른다"(예산 초과 무표기)를 화면에서 미리 알린다(실사용 제보 2026-07-31).
    // omitted = ref 상한(SKILL_REF_CAP)까지 넘쳐 이름조차 미주입 — 'ref'로 뭉개면 21번째부터
    // "참조 주입됨" 배지가 거짓이 된다(검수 R2).
    installedSkills: (() => {
      const { ref, omitted } = planSkillInjection(skills.map((s) => ({ id: s.id, size: s.size })));
      const refSet = new Set(ref);
      const omittedSet = new Set(omitted);
      return skills.map((s) => ({ ...s, injected: omittedSet.has(s.id) ? 'omitted' : refSet.has(s.id) ? 'ref' : 'full' }));
    })(),
    // env(토큰 값)는 응답에서 제거 — 화면은 command/args만 쓴다(로그·프록시·캐시 유출 방지, 검수 MEDIUM).
    installedMcp: Object.fromEntries(Object.entries(mcp.servers ?? {}).map(([n, d]) => {
      const { env, headers, ...safe } = d ?? {};
      return [n, {
        ...safe,
        ...((env && Object.keys(env).length) || (headers && Object.keys(headers).length) ? { hasSecrets: true } : {}),
        // 이 환경에서 실행 안 됨(로컬 프로세스 spawn 차단) — UI가 "설치됨"이 아니라 "로컬 앱 전용"으로 정직 표기
        ...(n in runnable ? {} : { runtimeBlocked: true }),
      }];
    })),
    // 이 컴퓨터의 Claude Code MCP — 로컬 앱 전용(호스팅 모드에선 숨김). env 값은 안 실린다(요약만).
    hostMcp: arbitraryMcpBlocked() ? [] : await listHostMcp(),
    // 로컬 프로세스를 spawn하는 커스텀·npm MCP를 이 환경에서 추가·실행할 수 있는가(데스크톱=예, 서비스키 웹=아니오).
    // 카탈로그·원격(HTTP) MCP는 이 값과 무관하게 항상 원클릭 가능하다.
    customMcpAllowed: !arbitraryMcpBlocked(),
  });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const body = await req.json();
    if (body.kind === 'skill') {
      const { lang = 'ko' } = await loadCompany(ws).catch(() => ({})); // 회사 시스템 언어 — 설치 md가 이 언어를 따른다
      await installSkill(ws, body.id, lang);
    }
    else if (body.kind === 'connector') {
      // 연결 시작 — 응답은 즉시(authUrl), 완료는 GET 폴링(connectors[].status)으로 관측한다.
      // 인가 자체는 사용자 브라우저 몫이라 여기서 기다리면 라우트가 최대 120초 잡힌다.
      const { lang = 'ko' } = await loadCompany(ws).catch(() => ({}));
      const { authUrl } = await connectConnector(ws, String(body.id ?? ''), { lang });
      return Response.json({ ok: true, authUrl });
    }
    else if (body.kind === 'mcp') await installMcp(ws, body.id);
    else if (body.kind === 'mcp-custom') await addCustomMcp(ws, body.def ?? {});
    else if (body.kind === 'mcp-host') await importHostMcp(ws, String(body.id ?? '')); // 이 컴퓨터에서 가져오기(env 포함)
    else if (body.kind === 'skill-custom') await saveCustomSkill(ws, body.def ?? {}); // 공방 — 직접 쓰는 스킬
    else if (body.kind === 'remote-skill') await installRemoteSkill(ws, body.item ?? {});
    else if (body.kind === 'remote-mcp') await installRemoteMcp(ws, body.item ?? {}); // npm 분기 가드는 installRemoteMcp 내부(P0-2). http 원격은 로컬 실행 없어 허용
    else if (body.kind === 'explain') {
      const { lang = 'ko' } = await loadCompany(ws).catch(() => ({})); // 회사 시스템 언어 — 없으면 ko 폴백
      return Response.json(await explainItem(body.item ?? {}, lang));
    }
    else return Response.json({ error: '알 수 없는 kind' }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const u = new URL(req.url);
  const kind = u.searchParams.get('kind');
  const id = u.searchParams.get('id');
  if (!kind || !id) return Response.json({ error: 'kind·id가 필요합니다' }, { status: 400 });
  if (kind === 'skill') await removeSkill(ws, id);
  // 커넥터 해제 = 토큰·클라이언트 자격 삭제 + 풀 정리. 명시 분기다 — else(=MCP)로 흘려보내면
  // 존재하지 않는 MCP 서버를 지우고 ok를 돌려주는 조용한 무동작이 된다.
  else if (kind === 'connector') await disconnectConnector(ws, id);
  else await removeMcp(ws, id);
  return Response.json({ ok: true });
}
