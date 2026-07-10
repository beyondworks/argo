import { RUNNERS, detectRunners } from '../../../src/runners.mjs';

// 러너 카탈로그 + 로컬 설치·인증 상태 — 크루 편집 모달의 러너 선택이 이걸 먹는다.
export async function GET() {
  const status = await detectRunners();
  const runners = Object.entries(RUNNERS).map(([id, r]) => ({
    id, name: r.name, kind: r.kind, models: r.models,
    installed: status[id]?.installed ?? false,
    authed: status[id]?.authed ?? false,
  }));
  return Response.json({ runners });
}
