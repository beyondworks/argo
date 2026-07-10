import { readActivity } from '../../../../../src/usage.mjs';
import { loadApprovals } from '../../../../../src/approvals.mjs';

/** 활동 타임라인 — 턴(대화·위임·루틴·메신저·영입) + 결재 이벤트를 시간 역순으로 병합. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const [turns, approvals] = await Promise.all([readActivity(ws, 80), loadApprovals(ws)]);
  const events = [
    ...turns,
    ...approvals.flatMap((a) => [
      { ts: a.createdAt, kind: 'approval', slug: a.slug, action: a.action, status: 'pending' },
      ...(a.resolvedAt ? [{ ts: a.resolvedAt, kind: 'approval', slug: a.slug, action: a.action, status: a.status }] : []),
    ]),
  ].sort((x, y) => String(y.ts).localeCompare(String(x.ts))).slice(0, 80);
  return Response.json({ events });
}
