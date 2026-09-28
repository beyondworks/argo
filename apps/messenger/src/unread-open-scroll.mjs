// 대화를 열 때 스크롤 목표(순수) — 유건 확정 2026-09-29.
// 안 읽은 글이 있고(구분선 존재) 그 구분선부터 바닥까지가 한 화면에 다 안 들어가면, 구분선이 위쪽 1/3에 오도록 연다(바닥 고정은 끈다).
// 한 화면에 다 들어가면(또는 안 읽은 글이 없으면) 지금처럼 맨 아래로 + 바닥 고정.
// 100개 넘는 안 읽은 글(최초 로드 페이지 밖)은 구분선 자체가 안 그려져 dividerTop이 null로 들어온다 — 이 경우도 맨 아래로 폴백(미완, 후속 과제).
export const UNREAD_OPEN_TOP_RATIO = 1 / 3;

export function unreadFitsOneScreen(scrollHeight, dividerTop, clientHeight) {
  return scrollHeight - dividerTop <= clientHeight;
}

export function unreadOpenScrollTarget({ scrollHeight, dividerTop, clientHeight, ratio = UNREAD_OPEN_TOP_RATIO }) {
  const max = Math.max(0, scrollHeight - clientHeight);
  if (dividerTop == null || unreadFitsOneScreen(scrollHeight, dividerTop, clientHeight)) return { scrollTop: max, stick: true };
  const raw = dividerTop - clientHeight * ratio;
  return { scrollTop: Math.min(Math.max(0, raw), max), stick: false };
}
