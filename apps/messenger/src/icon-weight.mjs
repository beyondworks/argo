// 아이콘 굵기 기준(유건 결정 2026-10-02) — 화면에 18px 이하로 그려지는 아이콘은 Material Symbols 굵기 500, 19px 이상은 400.
// 작은 크기에서 400은 선이 1.2px 안팎으로 가늘어 흐려 보였다. icons.jsx의 <I>가 이 함수 하나로 path를 고른다(size = 실제로 그려지는 크기).
export const SMALL_MAX = 18;
export const weightFor = (size) => (size <= SMALL_MAX ? 500 : 400);
