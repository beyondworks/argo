// 토큰 사용량 — 턴마다 usage.jsonl에 append, 대시보드용 집계를 제공한다.
// 효율 지표(팩트 기준): ① 캐시 적중률(높을수록 같은 맥락을 싸게 재사용 — 캐시 읽기는 정가의 ~1/10)
// ② 턴당 비용. 입력≫출력은 에이전트 작업의 정상 형태(근거를 읽고 짧게 생성)다.
import { appendFile, readFile } from 'node:fs/promises';
import { paths } from './workspace.mjs';

/** SDK result 메시지의 usage를 한 줄로 기록. kind: 'chat' | 'hire' | 'delegate'(from=위임한 크루). */
export async function appendUsage(wsId, { kind, slug, from, runner, model, usage, costUsd, ms, tools, billed }) {
  if (!usage) return;
  const row = {
    ts: new Date().toISOString(),
    kind, slug: slug ?? '',
    ...(from ? { from } : {}),
    ...(runner ? { runner } : {}), // 러너 명시 기록 — 모델명 파싱 대신 이 값이 정본
    ...(model ? { model } : {}),
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    costUsd: costUsd ?? null,
    // 청구 여부 — false면 구독(OAuth·호스트 로그인) 턴이라 금액 집계에서 뺀다.
    // 필드가 없는 행의 청구 판정은 rowBilled(현재 자격 기준)가 한다 — 표지는 보조 신호다.
    ...(billed === false ? { billed: false } : {}),
    ms: ms ?? null,
    ...(tools && Object.keys(tools).length ? { tools } : {}),
  };
  try {
    await appendFile(paths(wsId).usage, `${JSON.stringify(row)}\n`);
  } catch { /* 기록 실패가 턴을 막으면 안 된다 */ }
}

/** 행의 러너 도출(순수) — 명시 runner 필드가 정본, 없는 구행은 모델명에서 폴백.
    (monthCostByRunner에 있던 규칙을 승격 — 청구 판정이 행 단위로 이 값을 쓴다.) */
export function rowRunner(r) {
  if (r.runner) return String(r.runner);
  const m = String(r.model ?? '');
  if (m.includes(':')) return m.split(':')[0];
  if (/^glm/i.test(m)) return 'glm';
  return 'claude';
}

/** 행 단위 청구 판정(순수) — **이 판정이 모든 금액 표면의 단일 진실이다** (2026-07-27 확정).
    billedMap = { 러너id: 현재 자격이 apikey인가 } (billing.mjs가 만든다).
    - billed === false 행(구독 턴 명시)은 항상 비청구.
    - map이 있으면: 그 행의 러너가 **지금 API 키로 연결돼 있을 때만** 청구로 본다.
      과거 행의 표지 유무에 기대지 않는다 — v0.1.29의 "옛 행은 청구로 본다"는 소급 보수가
      구독 전용 회사에 잔존 금액을 계속 표시하는 신고를 낳았다(실사용 2026-07-26·27).
      자격이 없거나 모르는 러너는 비청구(돈이 나갈 경로가 없다) — 오해 방향으로 죽지 않는다.
    - map이 없으면(구 경로·테스트): 이전 동작 유지. 프로덕션 소비자는 billing.mjs를 통해서만
      집계를 쓰도록 트립와이어가 강제한다. */
export const rowBilled = (r, billedMap) =>
  r.billed === false ? false : !billedMap ? true : billedMap[rowRunner(r)] === true;

async function readRows(wsId) {
  try {
    const text = await readFile(paths(wsId).usage, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; /* 아직 기록 없음 */ }
}

/** 활동 피드 — 모든 턴(대화·위임·루틴·메신저·영입)을 최신순으로. */
export async function readActivity(wsId, limit = 60) {
  const rows = await readRows(wsId);
  return rows.slice(-limit).reverse().map((r) => ({
    ts: r.ts, kind: r.kind, slug: r.slug, from: r.from ?? null,
    ms: r.ms ?? null, costUsd: r.costUsd ?? null, output: r.output ?? 0,
  }));
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

export async function readUsageSummary(wsId, billedMap) {
  const rows = await readRows(wsId);

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  // subTurns = 구독(OAuth) 연결로 돈 턴. SDK는 이런 턴에도 정가 상당액을 리포트하지만 **청구되지 않는다** —
  // 그대로 더해 보여주면 "구독료 안인지 추가 청구인지 헷갈린다"가 된다(실사용 신고 2026-07-26).
  // 금액에서 빼고 개수만 세어, 화면이 "얼마 나갔다"와 "구독으로 썼다"를 구분해 말할 수 있게 한다.
  // 청구/구독 판정은 rowBilled(단일 진실 — 현재 자격 기준) 하나만 쓴다.
  const agg = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, hasCost: false, subTurns: 0 });
  const sum = { today: agg(), month: agg(), total: agg() };
  for (const r of rows) {
    const keys = ['total'];
    if (r.ts?.startsWith(month)) keys.push('month');
    if (r.ts?.startsWith(today)) keys.push('today');
    for (const key of keys) {
      const s = sum[key];
      s.turns += 1;
      s.input += r.input; s.output += r.output;
      s.cacheRead += r.cacheRead; s.cacheCreate += r.cacheCreate;
      if (!rowBilled(r, billedMap)) s.subTurns += 1;
      else if (typeof r.costUsd === 'number') { s.costUsd += r.costUsd; s.hasCost = true; }
    }
  }
  const enrich = (s) => ({
    ...s,
    contextTotal: s.input + s.cacheRead + s.cacheCreate,           // 모델이 읽은 전체 맥락
    cacheHitRate: s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : 0, // 효율 ①
    inPerOut: s.output > 0 ? (s.input + s.cacheRead + s.cacheCreate) / s.output : 0,     // 출력 1토큰당 읽은 맥락
    costPerTurn: s.turns > 0 && s.hasCost ? s.costUsd / s.turns : null,                   // 효율 ②
  });
  return { today: enrich(sum.today), month: enrich(sum.month), total: enrich(sum.total) };
}

/** 크루 1명의 누적 통계 — 카드 패널 "상세 정보"의 원천. */
export async function agentStats(wsId, slug, billedMap) {
  const rows = (await readRows(wsId)).filter((r) => r.slug === slug);
  const s = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, hasCost: false, ms: 0, msCount: 0 };
  const tools = {};
  for (const r of rows) {
    s.turns += 1;
    s.input += r.input ?? 0; s.output += r.output ?? 0;
    s.cacheRead += r.cacheRead ?? 0; s.cacheCreate += r.cacheCreate ?? 0;
    if (rowBilled(r, billedMap) && typeof r.costUsd === 'number') { s.costUsd += r.costUsd; s.hasCost = true; }
    if (typeof r.ms === 'number') { s.ms += r.ms; s.msCount += 1; }
    for (const [k, v] of Object.entries(r.tools ?? {})) tools[k] = (tools[k] ?? 0) + v;
  }
  const topTools = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, count]) => ({ name: name.replace(/^mcp__/, '').replace(/__/g, '·'), count }));
  return {
    turns: s.turns,
    contextTotal: s.input + s.cacheRead + s.cacheCreate, // 읽은 맥락
    output: s.output,                                     // 생성
    costUsd: s.hasCost ? s.costUsd : null,
    avgMs: s.msCount ? Math.round(s.ms / s.msCount) : null,
    topTools,
  };
}

/** 이번 달 크루별 인건비 — 급여 대장(데크). 비용 큰 순. */
export async function monthCostByCrew(wsId, billedMap) {
  const month = new Date().toISOString().slice(0, 7);
  const by = {};
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month) || !r.slug) continue;
    const b = (by[r.slug] ??= { slug: r.slug, costUsd: 0, turns: 0, hasCost: false });
    b.turns += 1;
    if (rowBilled(r, billedMap) && typeof r.costUsd === 'number') { b.costUsd += r.costUsd; b.hasCost = true; }
  }
  return Object.values(by).sort((a, b) => b.costUsd - a.costUsd);
}

/** 이번 달 러너별 사용량 — 설정 러너 카드 표시용. 러너 도출은 rowRunner(정본). */
export async function monthCostByRunner(wsId, billedMap) {
  const month = new Date().toISOString().slice(0, 7);
  const by = {};
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month)) continue;
    const runner = rowRunner(r);
    const b = (by[runner] ??= { turns: 0, costUsd: 0, hasCost: false });
    b.turns += 1;
    if (rowBilled(r, billedMap) && typeof r.costUsd === 'number') { b.costUsd += r.costUsd; b.hasCost = true; }
  }
  return by;
}

/** 이번 달 사용량 — { costUsd, subTurns }.
    ⚠ costUsd는 **실제로 청구되는 턴만** 더한다(판정 = rowBilled 단일 진실 — 현재 자격 기준).
    구독(OAuth) 연결은 SDK가 정가 상당액을 리포트하지만 그 돈이 청구되지는 않는다 —
    그대로 표시하면 "구독료 안인지 추가 청구인지 헷갈린다"가 된다(실사용 신고 2026-07-26·27). */
export async function monthCost(wsId, billedMap) {
  const month = new Date().toISOString().slice(0, 7);
  let costUsd = 0, subTurns = 0;
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month)) continue;
    if (!rowBilled(r, billedMap)) { subTurns += 1; continue; }
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
  }
  return { costUsd, subTurns };
}
