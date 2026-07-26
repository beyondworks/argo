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
    // 청구 여부 — false면 구독(OAuth·호스트 로그인) 턴이라 금액 집계에서 뺀다. 필드가 없는 옛 행은
    // 청구로 본다(소급 변경 금지 — 과거 집계가 흔들린다).
    ...(billed === false ? { billed: false } : {}),
    ms: ms ?? null,
    ...(tools && Object.keys(tools).length ? { tools } : {}),
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

export async function readUsageSummary(wsId) {
  const rows = await readRows(wsId);

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  // subTurns = 구독(OAuth) 연결로 돈 턴. SDK는 이런 턴에도 정가 상당액을 리포트하지만 **청구되지 않는다** —
  // 그대로 더해 보여주면 "구독료 안인지 추가 청구인지 헷갈린다"가 된다(실사용 신고 2026-07-26).
  // 금액에서 빼고 개수만 세어, 화면이 "얼마 나갔다"와 "구독으로 썼다"를 구분해 말할 수 있게 한다.
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
      // billed === false(구독 턴)는 금액에서 제외. billed 없는 옛 행은 청구로 본다 — 소급해서 금액을
      // 지우면 과거 집계가 흔들린다(이전 동작 유지).
      if (r.billed === false) s.subTurns += 1;
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
export async function agentStats(wsId, slug) {
  const rows = (await readRows(wsId)).filter((r) => r.slug === slug);
  const s = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, hasCost: false, ms: 0, msCount: 0 };
  const tools = {};
  for (const r of rows) {
    s.turns += 1;
    s.input += r.input ?? 0; s.output += r.output ?? 0;
    s.cacheRead += r.cacheRead ?? 0; s.cacheCreate += r.cacheCreate ?? 0;
    if (typeof r.costUsd === 'number') { s.costUsd += r.costUsd; s.hasCost = true; }
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
export async function monthCostByCrew(wsId) {
  const month = new Date().toISOString().slice(0, 7);
  const by = {};
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month) || !r.slug) continue;
    const b = (by[r.slug] ??= { slug: r.slug, costUsd: 0, turns: 0, hasCost: false });
    b.turns += 1;
    if (typeof r.costUsd === 'number') { b.costUsd += r.costUsd; b.hasCost = true; }
  }
  return Object.values(by).sort((a, b) => b.costUsd - a.costUsd);
}

/** 이번 달 러너별 사용량 — 설정 러너 카드 표시용. 러너는 기록된 모델명에서 도출한다
    (외부 CLI는 'codex:모델'로 기록, GLM은 SDK 경유라 모델명이 glm-*, 그 외·미기록은 기본 러너 claude). */
export async function monthCostByRunner(wsId) {
  const month = new Date().toISOString().slice(0, 7);
  const by = {};
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month)) continue;
    const m = String(r.model ?? '');
    // 명시 runner 필드 우선(정본) — 없는 구행만 모델명에서 도출(폴백)
    const runner = r.runner ? String(r.runner)
      : m.includes(':') ? m.split(':')[0]
      : /^glm/i.test(m) ? 'glm'
      : 'claude';
    const b = (by[runner] ??= { turns: 0, costUsd: 0, hasCost: false });
    b.turns += 1;
    if (typeof r.costUsd === 'number') { b.costUsd += r.costUsd; b.hasCost = true; }
  }
  return by;
}

/** 이번 달 사용량 — { costUsd, subTurns }.
    ⚠ costUsd는 **실제로 청구되는 턴만** 더한다. 구독(OAuth) 연결은 SDK가 정가 상당액을 리포트하지만
    그 돈이 청구되지는 않는다 — 그대로 표시하면 "구독료 안인지 추가 청구인지 헷갈린다"가 된다
    (실사용 신고 2026-07-26). billed === false인 행은 금액에서 빼고 턴 수만 센다.
    billed가 없는 옛 행은 청구로 본다(이전 동작 유지 — 소급해서 금액을 지우면 과거 집계가 흔들린다). */
export async function monthCost(wsId) {
  const month = new Date().toISOString().slice(0, 7);
  let costUsd = 0, subTurns = 0;
  for (const r of await readRows(wsId)) {
    if (!r.ts?.startsWith(month)) continue;
    if (r.billed === false) { subTurns += 1; continue; }
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
  }
  return { costUsd, subTurns };
}
