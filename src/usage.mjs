// 토큰 사용량 — 턴마다 usage.jsonl에 append, 대시보드용 집계를 제공한다.
// 효율 지표(팩트 기준): ① 캐시 적중률(높을수록 같은 맥락을 싸게 재사용 — 캐시 읽기는 정가의 ~1/10)
// ② 턴당 비용. 입력≫출력은 에이전트 작업의 정상 형태(근거를 읽고 짧게 생성)다.
import { appendFile, readFile } from 'node:fs/promises';
import { paths } from './workspace.mjs';

/** SDK result 메시지의 usage를 한 줄로 기록. kind: 'chat' | 'hire' | 'delegate'(from=위임한 크루). */
export async function appendUsage(wsId, { kind, slug, from, usage, costUsd, ms }) {
  if (!usage) return;
  const row = {
    ts: new Date().toISOString(),
    kind, slug: slug ?? '',
    ...(from ? { from } : {}),
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    costUsd: costUsd ?? null,
    ms: ms ?? null,
  };
  try {
    await appendFile(paths(wsId).usage, `${JSON.stringify(row)}\n`);
  } catch { /* 기록 실패가 턴을 막으면 안 된다 */ }
}

async function readRows(wsId) {
  try {
    const text = await readFile(paths(wsId).usage, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; /* 아직 기록 없음 */ }
}

/** 위임 이력 — 그래프 크루↔크루 엣지·활동 피드의 원천. 최신순. */
export async function readDelegations(wsId, limit = 30) {
  const rows = await readRows(wsId);
  return rows
    .filter((r) => r.kind === 'delegate' && r.from && r.slug)
    .slice(-limit)
    .reverse()
    .map((r) => ({ ts: r.ts, from: r.from, to: r.slug, ms: r.ms ?? null }));
}

export async function readUsageSummary(wsId) {
  const rows = await readRows(wsId);

  const today = new Date().toISOString().slice(0, 10);
  const agg = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, hasCost: false });
  const sum = { today: agg(), total: agg() };
  for (const r of rows) {
    for (const key of r.ts?.startsWith(today) ? ['today', 'total'] : ['total']) {
      const s = sum[key];
      s.turns += 1;
      s.input += r.input; s.output += r.output;
      s.cacheRead += r.cacheRead; s.cacheCreate += r.cacheCreate;
      if (typeof r.costUsd === 'number') { s.costUsd += r.costUsd; s.hasCost = true; }
    }
  }
  const enrich = (s) => ({
    ...s,
    contextTotal: s.input + s.cacheRead + s.cacheCreate,           // 모델이 읽은 전체 맥락
    cacheHitRate: s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : 0, // 효율 ①
    inPerOut: s.output > 0 ? (s.input + s.cacheRead + s.cacheCreate) / s.output : 0,     // 출력 1토큰당 읽은 맥락
    costPerTurn: s.turns > 0 && s.hasCost ? s.costUsd / s.turns : null,                   // 효율 ②
  });
  return { today: enrich(sum.today), total: enrich(sum.total) };
}
