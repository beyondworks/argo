import { RUNNERS, detectRunners, runnerStatus } from '../../../src/runners.mjs';
import { guardCompany } from '../../auth.mjs';

// 러너 카탈로그 + 로컬 설치·인증 상태 — 크루 편집 모달·크루 카드·채팅 셀렉터가 먹는다.
// ?ws=<회사>를 주면 그 회사의 연결(설정 → 러너 연결)을 병합해, 회사 자격이 있으면
// 호스트 로그인이 없어도 선택 가능(authed)으로 표시한다.
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
    const companyConnected = !!c?.company?.connected;
    return {
      id, name: r.name, kind: r.kind, models: r.models,
      installed: status[id]?.installed ?? false,
      // 회사 자격(API키/OAuth 토큰)이 있으면 호스트 로그인 없이도 사용 가능
      authed: (status[id]?.authed ?? false) || companyConnected,
      companyConnected,
      via: companyConnected ? c.company.type : (c?.hostAuthed || status[id]?.authed ? 'host' : null),
    };
  });
  return Response.json({ runners });
}
