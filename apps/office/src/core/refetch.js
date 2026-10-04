// 다른 기기 변경 반영(18차, PARITY-tasks A25·C2·C11) — 새 주기 폴링 없이, 탭(창)으로 돌아올 때만 할 일·일정을 다시 읽는다.
// 부하: 사람 1명 × (할 일 1 + 일정 1) = 분당 최대 2회 읽기, 쓰기 0. 판정은 순수 함수(test/refetch.test.mjs·r18-review.test.mjs), 실제 읽기는 core/tasks.js·calendar/api.js.
import { kstDay } from './task-model.js';

export const RETURN_GAP = 60_000;
/** 다시 읽을 때인가 — 탭이 보이고, 마지막으로 읽은(또는 읽으려 한) 때에서 1분이 지났고, 쓰는 중이 아닐 때만.
 *  이유: 탭을 자주 오가도 같은 화면은 분당 한 번까지만 읽고, 쓰는 사이에 읽으면 막 고친 값이 옛 값으로 덮여 보인다(페이지 탭 복귀 최신화와 같은 규칙) */
export const refetchDue = ({ hidden, now, last, busy, gap = RETURN_GAP }) => !hidden && !busy && now - (last || 0) >= gap;

/** 탭으로 돌아오거나(visibilitychange) 창에 초점이 올 때(focus — 같은 브라우저의 다른 창에서 돌아올 때) fn. 둘이 같이 와도 fn 쪽 간격 판정이 한 번만 읽게 한다 */
export function onTabReturn(fn) {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', fn);
  addEventListener('focus', fn);
}

/** 늦게 온 응답을 받을지 — 요청 때와 지금 계정이 다르면 버린다(계정을 바꾸는 사이 옛 계정 응답이 섞이지 않게, 검수 LOW 10).
 *  탭 복귀 읽기(quiet)는 그 사이 쓰기가 시작됐거나(writing) 더 새 읽기가 먼저 끝났으면(newerAt > started) 버린다 — 막 고친 값을 옛 값으로 덮지 않게 */
export const keepResponse = ({ owner, nowOwner, quiet = false, writing = 0, started = 0, newerAt = 0 }) => owner === nowOwner && !(quiet && (writing > 0 || newerAt > started));

/** 받아 둔 것을 다시 쓸지 — 같은 계정이고 gap(기본 30초) 안에 받은 것. 이유(DB 위생, 검수 LOW 11): 화면을 열 때마다 같은 것을 다시 읽지 않는다(할 일 읽기와 같은 30초) */
export const cacheFresh = (entry, { now, owner, gap = 30_000 }) => !!entry && entry.owner === owner && now - entry.at < gap;

/** 한국 날짜 시계 — check(now)는 날짜가 바뀌었을 때만 true(자정을 넘긴 뒤 탭 복귀 때 '오늘'을 다시 계산, 검수 LOW 6) */
export function makeDayClock(now = Date.now()) {
  let day = kstDay(new Date(now));
  return { day: () => day, check: (t = Date.now()) => { const next = kstDay(new Date(t)); if (next === day) return false; day = next; return true; } };
}
