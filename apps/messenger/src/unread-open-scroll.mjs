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

// 대화가 실제로 화면에 있는가 — 폰 홈·채팅 목록 탭은 마지막 대화를 display:none으로 그려 둔다(styles.css .phone-home .msgr-main).
// 그 상태에서 읽음 처리·첫 스크롤 계산을 하면 열지도 않은 대화가 읽음이 되고, 높이 0에서 계산한 위치로 굳는다(2026-09-29 점검).
export const channelOnScreen = ({ isPhone, page }) => !(isPhone && (page === 'home' || page === 'dm'));
