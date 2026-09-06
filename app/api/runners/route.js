import { RUNNERS, detectRunners, runnerStatus, autoRunnerOf, isHiddenRunner } from '../../../src/runners.mjs';
import { effectiveModels, loadRemoteCatalog } from '../../../src/runners/catalog-remote.mjs'; // 원격 카탈로그 오버레이(불변식 D)
import { guardCompany } from '../../auth.mjs';

// 러너 카탈로그 + 설치·연결 상태 — 크루 편집 모달·크루 카드·채팅 셀렉터가 먹는다.
// 판정은 명시 연결 정본(유건 지시 2026-07-19)과 동일: authed = 회사 자격 연결(유효)뿐.
// 호스트 로그인 감지는 authed에 포함하지 않는다 — 설정 칩('연결됨')과 셀렉터('연결 필요')가
// 서로 다른 판정을 쓰던 표시 모순의 원인이었다(실사용 신고: 상단 연결됨 + 하단 연결 안 됨).
export async function GET(req) {
  const ws = new URL(req.url).searchParams.get('ws');
  let company = null;
  if (ws) {
    const denied = await guardCompany(ws); if (denied) return denied;
    company = await runnerStatus(ws).catch(() => null);
  }
  const status = await detectRunners();
  // 숨김 러너(gemini)도 목록에 **남긴다** — hidden 표지만 싣는다. 목록에서 빼면 이미 gemini로 지정된 크루의 셀렉터가
  // 현재 값을 못 찾아 "자동"으로 오표시됐다(분리 검수 HIGH-2 실측). 선택지에서 빼는 것은 소비자(크루 카드·편집 모달·
  // 경쟁 슬롯)가 hidden으로 한다 — 현재 값일 때만 예외로 보여 정직 표기.
  await loadRemoteCatalog({ timeoutMs: 2000 }).catch(() => null); // TTL 20분 — 대부분 즉시 반환. 실패는 코드 목록 그대로
  const runners = Object.entries(RUNNERS).map(([id, r]) => {
    const c = company?.[id];
    const companyConnected = !!c?.company?.connected && !c?.company?.invalid; // 무효(재연결 필요)는 미연결 취급
    return {
      id, name: r.name, kind: r.kind, mcp: !!r.mcp, models: effectiveModels(id), hidden: isHiddenRunner(id),
      installed: status[id]?.installed ?? false,
      authed: companyConnected, // 명시 연결만 — 게이트·실행(pickRunner)과 동일 판정
      companyConnected,
      via: companyConnected ? c.company.type : null,
    };
  });
  // 자동 크루의 실제 러너 — 판정은 코어(autoRunnerOf = pickRunner ∘ 회사상태), 여긴 배선만.
  // 클라가 폴백 순서를 복제하면 갈라진다(검수 L4: 경고 조건 r.id===sel.runner가 영원히 거짓).
  return Response.json({ runners, autoRunnerId: autoRunnerOf(company) });
}
