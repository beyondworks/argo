// 실패 서명 다이제스트 — "사용자가 말하지 않은 오류"를 상주가 먼저 알아채는 장치(2026-09-06 Grok 400 제보 뒤, 유건 승인 재발 방지 5).
//
// 왜: v0.1.62 Grok 턴 전멸은 같은 400 원문이 회사 활동 로그에 매 턴 쌓였는데 아무도 세지 않아 사용자 제보(PDF)로 알았다. GLM 5.3 404 고착도 같은 모양이었다.
// 무엇: 최근 24시간 실패 턴(중단 제외)을 (러너, 정규화한 오류 서명)으로 묶어 N회 이상 반복되면 활동 이벤트 한 줄로 드러낸다 — 같은 서명은 24시간에 한 번만.
// 절대 제약: 읽기 전용(자격·턴·상태를 바꾸지 않는다), 벤더 호출 0, 이벤트는 서명당 하루 1행(타임라인 오염 금지).
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { readEvents, appendEvent } from './events.mjs';

export const DIGEST_WINDOW_MS = 24 * 60 * 60_000;
export const DIGEST_MIN_COUNT = 3;
export const DIGEST_REPORT_INTERVAL_MS = 24 * 60 * 60_000;
export const DIGEST_FILE_NAME = '.failure-digest.json';
const digestFile = (wsId) => join(paths(wsId).root, DIGEST_FILE_NAME);

/** 오류 원문 → 서명(순수). 가변 부분(긴 숫자·16진 id·경로·따옴표 안 값)을 접어 같은 원인이 같은 열쇠로 모이게 한다. HTTP 상태(3자리)는 원인이라 남긴다. */
export function errorSignature(error) {
  return String(error ?? '')
    .replace(/\s+/g, ' ').trim()
    .replace(/[0-9a-f]{12,}/gi, '#')          // 요청 id·해시
    .replace(/\b(?=[\w-]*\d)[\w-]{8,}\b/g, '#') // 숫자가 섞인 긴 토큰(gen-1788680877-h50B…, req_a1b2… 같은 요청 id)
    .replace(/\b\d{4,}\b/g, '#')              // 긴 숫자(타임스탬프·바이트 수), 3자리 상태 코드는 보존
    .replace(/\/[^\s"'()]+/g, '/…')           // 경로·URL 경로
    .replace(/"[^"]{0,80}"/g, (m) => (/^"(array|object|string|number|boolean|null)"$/.test(m) ? m : '"…"')) // 따옴표 값(타입 이름은 원인이라 보존)
    .slice(0, 160);
}

/** 실패 턴 묶기(순수). events = readEvents 결과(어느 순서든), now 기준 windowMs 안의 ok:false 턴(중단 제외)을 (runner, signature)로. count ≥ minCount만, 많은 순. */
export function digestFailures(events, { now = Date.now(), windowMs = DIGEST_WINDOW_MS, minCount = DIGEST_MIN_COUNT } = {}) {
  const groups = new Map();
  for (const e of events ?? []) {
    if (e?.type !== 'turn' || e.ok !== false || e.aborted === true || !e.error) continue;
    const ts = Date.parse(e.ts ?? ''); if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 60_000) continue;
    const runner = e.runner || 'unknown'; const signature = errorSignature(e.error); const key = `${runner}|${signature}`;
    const g = groups.get(key) ?? { runner, signature, count: 0, firstTs: ts, lastTs: ts, sample: String(e.error).slice(0, 200), slugs: new Set() };
    g.count += 1; g.firstTs = Math.min(g.firstTs, ts); g.lastTs = Math.max(g.lastTs, ts); if (e.slug) g.slugs.add(e.slug);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.count >= minCount).sort((a, b) => b.count - a.count).map((g) => ({ ...g, slugs: [...g.slugs].sort() }));
}

/** 한 회사의 다이제스트 실행 — 새 서명(또는 마지막 보고 24h 경과)만 활동 이벤트 `failure-digest`로 남긴다. 반환 = 이번에 보고한 항목. (주입은 테스트 전용) */
export async function runFailureDigest(wsId, { now = Date.now(), readFn = readEvents, appendFn = appendEvent, minCount, windowMs, reportIntervalMs = DIGEST_REPORT_INTERVAL_MS } = {}) {
  const events = await readFn(wsId, 2000).catch(() => []);
  const groups = digestFailures(events, { now, minCount, windowMs });
  if (!groups.length) return [];
  const file = digestFile(wsId);
  const state = await readJson(file, {});
  const reported = [];
  for (const g of groups) {
    const key = `${g.runner}|${g.signature}`;
    const last = Number(state[key]?.reportedAt) || 0;
    if (now - last < reportIntervalMs) continue;
    await appendFn(wsId, { type: 'failure-digest', runner: g.runner, signature: g.signature, count: g.count, sample: g.sample, since: new Date(g.firstTs).toISOString(), crews: g.slugs.slice(0, 8) });
    state[key] = { reportedAt: now, count: g.count };
    reported.push(g);
  }
  // 30일 넘은 기록은 정리(파일이 무한히 자라지 않게)
  for (const [k, v] of Object.entries(state)) if (now - (Number(v?.reportedAt) || 0) > 30 * DIGEST_WINDOW_MS) delete state[k];
  if (reported.length) await writeJsonAtomic(file, state).catch(() => {});
  return reported;
}
