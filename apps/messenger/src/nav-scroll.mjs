// 가로로 스크롤되는 탭 줄에서 활성 탭을 줄 가운데로 가져올 scrollLeft(LA-11) — 줄 안에서만 움직이고 0..(전체 폭 − 보이는 폭)으로 자른다.
// 영어 360px 설정 탭 줄(보이는 폭 310, 전체 472)에서 '내 계정'이 줄 밖(x 397~491)에 있어 처음 들어오면 어느 탭인지 안 보였다.
export function scrollLeftToCenter({ navLeft, navWidth, btnLeft, btnWidth, scrollLeft, scrollWidth }) {
  if (!(scrollWidth > navWidth)) return scrollLeft; // 넘치지 않는 줄은 그대로
  const want = scrollLeft + (btnLeft + btnWidth / 2) - (navLeft + navWidth / 2);
  return Math.max(0, Math.min(scrollWidth - navWidth, Math.round(want)));
}
