import { loadCompany } from '../../../../src/workspace.mjs';
import { listAgents, listDocs } from '../../../../src/hub.mjs';

/** 대시보드 스탯 — 고유 연결 수(양방향 중복 제거), 오늘 기록, 종류별 수. */
function docStats(docs) {
  const keys = new Set(docs.map((d) => d.rel.replace(/\.md$/, '')));
  const edges = new Set();
  for (const d of docs) {
    const from = d.rel.replace(/\.md$/, '');
    for (const l of d.links) {
      if (keys.has(l)) edges.add([from, l].sort().join('→'));
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    links: edges.size,
    today: docs.filter((d) => d.rel.includes(today)).length,
    conversations: docs.filter((d) => d.dir === 'conversations').length,
    notes: docs.filter((d) => d.dir === 'notes').length,
  };
}

export async function GET(_req, { params }) {
  try {
    const { ws } = await params;
    const [company, agents, docs] = await Promise.all([
      loadCompany(ws), listAgents(ws), listDocs(ws),
    ]);
    return Response.json({
      company, agents,
      memories: docs.slice(0, 6),
      memoryCount: docs.length,
      stats: docStats(docs),
    });
  } catch {
    return Response.json({ error: '회사를 찾을 수 없습니다' }, { status: 404 });
  }
}
