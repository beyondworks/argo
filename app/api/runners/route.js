import { RUNNERS, detectRunners, runnerStatus } from '../../../src/runners.mjs';
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
  return Response.json({ runners });
}
