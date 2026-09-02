import { listAgents } from '../../../../../src/hub.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';
import { readEvents } from '../../../../../src/events.mjs';
import { guardCompany } from '../../../../auth.mjs';

// 백그라운드 작업 패널의 데이터 — 지금 도는 턴(크루별 상태 파일) + 최근 끝난 작업(events).
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  // ?light=1 — running만(사이드바 링·독 배지·데크 카드). recent는 events.jsonl **전량 파싱**(readEvents)이라 독이
  // 열렸을 때만 만든다 — 작성 중 3.5초 폴이 큰 워크스페이스에서 폴마다 이벤트 루프를 ~120ms 점유하던 비용
  // (분리 검수 2026-09-02 MEDIUM-2, 크루 30·10만 줄 합성 실측). 크루 페이지 패널 폴은 recent가 필요해 그대로.
  const light = new URL(req.url).searchParams.get('light') === '1';
  const agents = await listAgents(ws).catch(() => []);
  const running = (await Promise.all(
    agents.map(async (a) => {
      const s = await getTurnStatus(ws, a.slug);
      return s ? { slug: a.slug, name: a.name, ...s } : null;
    }),
  )).filter(Boolean);

  const events = light ? [] : await readEvents(ws, 200).catch(() => []);
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
