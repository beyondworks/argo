import { consolidateMemory, rollupJournals } from '../../../../../../src/consolidate.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export const maxDuration = 120; // 하이쿠 1턴 — 수십 초

/** 기억 정리 수동 실행 — 새 일지를 주제 노트로 정제 + 오래된 일지 주간 롤업. */
export async function POST(_req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const r = await consolidateMemory(ws);
    const { rolled } = await rollupJournals(ws);
    return Response.json({ ...r, rolled });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
