import { listAgents } from '../../../../../src/hub.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';
import { readEvents } from '../../../../../src/events.mjs';
import { guardCompany } from '../../../../auth.mjs';

// 백그라운드 작업 패널의 데이터 — 지금 도는 턴(크루별 상태 파일) + 최근 끝난 작업(events).
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const agents = await listAgents(ws).catch(() => []);
  const running = (await Promise.all(
    agents.map(async (a) => {
      const s = await getTurnStatus(ws, a.slug);
      return s ? { slug: a.slug, name: a.name, ...s } : null;
    }),
  )).filter(Boolean);

  const events = await readEvents(ws, 200).catch(() => []);
  const recent = events
    .filter((e) => ['turn', 'routine', 'consolidate'].includes(e.type))
    .slice(-15)
    .reverse()
    .map((e) => ({
      ts: e.ts, type: e.type, slug: e.slug ?? null, ok: e.ok !== false,
      ms: e.ms ?? null, gist: e.gist ?? e.title ?? '', source: e.source ?? null,
    }));

  return Response.json({ running, recent });
}
