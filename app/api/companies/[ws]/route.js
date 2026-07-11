import { loadCompany, updateCompany, archiveCompany } from '../../../../src/workspace.mjs';
import { listAgents, listDocs } from '../../../../src/hub.mjs';
import { readUsageSummary, readDelegations, monthCostByCrew } from '../../../../src/usage.mjs';
import { ensureScheduler } from '../../../../src/scheduler.mjs';
import { ensureGateway } from '../../../../src/gateway.mjs';

ensureScheduler(); // 앱 사용이 시작되면 루틴 스케줄러 상주
ensureGateway(); // 메신저 게이트웨이(텔레그램/슬랙) 상주

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
  // 최근 14일 일별 적립 수 — 관제탑 바 차트용
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d.slice(5), count: docs.filter((x) => x.rel.includes(d)).length });
  }
  return {
    links: edges.size,
    today: docs.filter((d) => d.rel.includes(today)).length,
    conversations: docs.filter((d) => d.dir !== 'notes').length, // 일지 + 구버전 기록
    notes: docs.filter((d) => d.dir === 'notes').length,
    daily,
  };
}

export async function GET(_req, { params }) {
  try {
    const { ws } = await params;
    const [company, agents, docs, usage, delegations, payroll] = await Promise.all([
      loadCompany(ws), listAgents(ws), listDocs(ws), readUsageSummary(ws), readDelegations(ws), monthCostByCrew(ws),
    ]);
    return Response.json({
      company, agents,
      memories: docs.slice(0, 6),
      memoryCount: docs.length,
      stats: docStats(docs),
      usage, delegations, payroll,
    });
  } catch {
    return Response.json({ error: '회사를 찾을 수 없습니다' }, { status: 404 });
  }
}

/** 회사 정보 수정 — 이름·월 예산(USD, 0=무제한). */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const { name, budgetUsd } = await req.json();
    const patch = {};
    if (name !== undefined) {
      if (!name.trim()) return Response.json({ error: '이름이 필요합니다' }, { status: 400 });
      patch.name = name.trim();
    }
    if (budgetUsd !== undefined) {
      const n = Number(budgetUsd);
      if (!Number.isFinite(n) || n < 0) return Response.json({ error: '예산은 0 이상의 숫자' }, { status: 400 });
      patch.budgetUsd = n;
    }
    const company = await updateCompany(ws, patch);
    return Response.json({ company });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 회사 보관 — 삭제 대신 workspaces/.archive/로 이동(복구 가능). */
export async function DELETE(_req, { params }) {
  try {
    const { ws } = await params;
    await archiveCompany(ws);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
