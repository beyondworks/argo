import { RUNNERS, detectRunners, runnerStatus, pickRunner } from '../../../src/runners.mjs';
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
  const runners = Object.entries(RUNNERS).map(([id, r]) => {
    const c = company?.[id];
    const companyConnected = !!c?.company?.connected && !c?.company?.invalid; // 무효(재연결 필요)는 미연결 취급
    return {
      id, name: r.name, kind: r.kind, models: r.models,
      installed: status[id]?.installed ?? false,
      authed: companyConnected, // 명시 연결만 — 게이트·실행(pickRunner)과 동일 판정
      companyConnected,
      via: companyConnected ? c.company.type : null,
    };
  });
  // 자동(카드에 러너 미지정) 크루가 실제로 받을 러너 — 턴과 같은 판정(pickRunner, 폴백 순서 포함)을
  // 서버가 내려준다. 클라가 폴백 순서를 복제하면 갈라진다(검수 L4: 자동 크루는 실행 러너가 CLI여도
  // 카드 경고 조건 r.id===sel.runner가 영원히 거짓 — 경고가 안 떴다).
  const auto = company ? pickRunner(company, null) : null;
  return Response.json({ runners, autoRunnerId: auto?.available ? auto.runner : null });
}
