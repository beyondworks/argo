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
export const DIGEST_FILE_NAME = '.failure-digest.json'; // 동기화 대상(sync EXCLUDE 아님, 봉투 켜짐이면 암호문) — 서명별 보고 시각은 그 기기가 아니라 회사의 사실이라 리더가 바뀌어도 같은 서명을 다시 보고하지 않는다(#446 검수 D12). 크루 셸 방어는 permission-gate WS_DOT_FILES(D1).
const digestFile = (wsId) => join(paths(wsId).root, DIGEST_FILE_NAME);

/** 오류 원문에서 벤더·실행기 원문 핵심만(순수) — chat.mjs가 앞뒤에 붙이는 Argo 층(대체 실행 접두·크래시 안내·`\n\n` 뒤 재연결 안내)을 벗긴다.
    같은 원인이 자가치유 선기록(원문)과 최종 기록(안내 덧붙음)으로 두 서명에 갈리던 것(#446 검수 D2), 안내가 160자 예산을 먹어 크래시 코드가 잘리던 것(D3). */
export function errorCore(error) {
  let s = String(error ?? '').replace(/\r/g, '').split('\n\n')[0];
  const marks = ['API Error:', 'exited with code', 'Error:', 'error:', '턴 실패:'].map((m) => s.indexOf(m)).filter((i) => i >= 0);
  if (marks.length) {
    const at = Math.min(...marks); // Argo 접두 뒤의 첫 원문 표지
    const open = s.lastIndexOf('(', at); // 크래시 안내는 원문을 뒤에 괄호로 감싼다(`안내 (Claude Code process exited with code N)`) — 괄호 안 원문 전체
    s = open >= 0 && s.endsWith(')') && !s.slice(open, at).includes(')') ? s.slice(open + 1, -1) : s.slice(at);
  }
  return s.replace(/^턴 실패: \w+ — /, '').trim();
}
const headTail = (s, head, tail) => (s.length <= head + tail + 3 ? s : `${s.slice(0, head)} … ${s.slice(-tail)}`);
/** 오류 원문 → 서명(순수). 원문 핵심을 뽑고 가변 부분(긴 숫자·16진 id·경로·따옴표 안 값)을 접어 같은 원인이 같은 열쇠로 모이게 한다.
    HTTP 상태(3자리)·프로세스 종료 코드(`code N`)는 원인이라 남긴다. 앞 80자 + 뒤 80자(꼬리의 크래시 코드·벤더 상세 보존). */
export function errorSignature(error) {
  const codes = []; // 프로세스 종료 코드는 접지 않는다(3221225477 vs 134는 다른 원인) — 숫자 없는 자리표시로 빼뒀다가 되돌린다
  const norm = errorCore(error)
    .replace(/\s+/g, ' ').trim()
    .replace(/\bcode (\d+)/g, (m, d) => { codes.push(d); return `code ⟨${String.fromCharCode(65 + codes.length - 1)}⟩`; })
    .replace(/[0-9a-f]{12,}/gi, '#')          // 요청 id·해시
    .replace(/\b(?=[\w-]*\d)[\w-]{8,}\b/g, '#') // 숫자가 섞인 긴 토큰(gen-1788680877-h50B…, req_a1b2… 같은 요청 id)
    .replace(/\b\d{4,}\b/g, '#')              // 긴 숫자(타임스탬프·바이트 수), 3자리 상태 코드는 보존
    .replace(/⟨([A-Z])⟩/g, (m, k) => codes[k.charCodeAt(0) - 65])
    .replace(/\/[^\s"'()]+/g, '/…')           // 경로·URL 경로
    .replace(/"[^"]{0,80}"/g, (m) => (/^"(array|object|string|number|boolean|null)"$/.test(m) ? m : '"…"')); // 따옴표 값(타입 이름은 원인이라 보존)
  return headTail(norm, 80, 80);
}
/** 표시용 샘플(순수) — 원문 핵심의 앞 140자 + 뒤 60자(크래시 코드·벤더 상세가 꼬리에 있다). */
export const errorSample = (error) => headTail(errorCore(error).replace(/\s+/g, ' ').trim(), 140, 60);

/** 실패 턴 묶기(순수). events = readEvents 결과(어느 순서든), now 기준 windowMs 안의 ok:false 턴(중단 제외)을 (runner, signature)로. count ≥ minCount만, 많은 순. */
export function digestFailures(events, { now = Date.now(), windowMs = DIGEST_WINDOW_MS, minCount = DIGEST_MIN_COUNT } = {}) {
  const groups = new Map();
  for (const e of events ?? []) {
    if (e?.type !== 'turn' || e.ok !== false || e.aborted === true || e.error === '사장 지시로 중단' || !e.error) continue; // 레거시 중단 문자열도 제외(runner-usable.lastTurnByRunner와 같은 술어 — D8)
    const ts = Date.parse(e.ts ?? ''); if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 60_000) continue;
    const runner = e.runner || 'unknown'; const signature = errorSignature(e.error); const key = `${runner}|${signature}`;
    const g = groups.get(key) ?? { runner, signature, count: 0, firstTs: ts, lastTs: ts, sample: errorSample(e.error), slugs: new Set() };
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
    await appendFn(wsId, { type: 'failure-digest', ok: false, runner: g.runner, signature: g.signature, count: g.count, sample: g.sample, since: new Date(g.firstTs).toISOString(), crews: g.slugs.slice(0, 8) }); // ok:false = '오류' 필터·오류 카운터·아침 조회에 포함(D4)
    state[key] = { reportedAt: now, count: g.count };
    reported.push(g);
  }
  // 30일 넘은 기록은 정리(파일이 무한히 자라지 않게)
  for (const [k, v] of Object.entries(state)) if (now - (Number(v?.reportedAt) || 0) > 30 * DIGEST_WINDOW_MS) delete state[k];
  if (reported.length) await writeJsonAtomic(file, state).catch(() => {});
  return reported;
}
