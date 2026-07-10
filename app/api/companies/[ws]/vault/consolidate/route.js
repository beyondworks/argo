import { consolidateMemory } from '../../../../../../src/consolidate.mjs';

export const maxDuration = 120; // 하이쿠 1턴 — 수십 초

/** 기억 정리 수동 실행 — 새 일지 내용을 주제 노트로 정제. 새 내용 없으면 notes: []. */
export async function POST(_req, { params }) {
  try {
    const { ws } = await params;
    const r = await consolidateMemory(ws);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
