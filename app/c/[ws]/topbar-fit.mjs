// 상단바 적재 조절(layout.jsx fitBar)의 순수 배선 — JSX 없이 node --test가 직접 검증한다(topbar-fit.test.mjs).
// 문제(UM1, 2026-10-05): fitBar는 크기 관찰(ResizeObserver)로만 다시 돌았다. '새 소식'·'새로 고침 실패' 같은 칩은 상단바 안에 생겨도 바 자체의
// 크기는 그대로(내용만 넘친다)라 관찰기가 안 돌고, 접기 단계가 걸리지 않은 채 넘쳤다(561 en: 상단바 21px·문서 13px, 360 en: 20px).
/** 상단바 안의 자식(칩·배지·슬롯 내용)이 생기거나 사라질 때 fit을 다시 부른다. 반환 = 해제 함수.
    속성 변화는 보지 않는다 — fit이 문서 루트 속성(data-narrow-*)을 바꾸는데, 그것이 다시 fit을 부르면 되먹임이 된다. */
export function watchTopbarContent(bar, fit, { MutationObserverImpl = globalThis.MutationObserver } = {}) {
  if (!bar || !MutationObserverImpl) return () => {};
  const observer = new MutationObserverImpl(() => fit());
  observer.observe(bar, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/* ─── 단계별 접기(2차 검수 M1·L3, 2026-10-05) ───
   칩 라벨이 시계·버전 숨김과 같은 단계에서 접혀 자리가 남아도 '새로 고침 실패' 글이 사라졌다. 이제 정보 가치가 낮은 것부터 한 단계씩 접고, 매 단계 다시 잰다:
   bar(시계·버전·스페이서) → notes(새 소식 칩 라벨) → error(오류 칩 라벨 — 가장 늦게) → shell(슬롯을 인라인 밴드로).
   슬롯을 밴드로 내려 자리가 생기면 칩 라벨은 다시 펼칠 수 있는 만큼 펼친다(shell 단계도 칩 접기를 새 소식 → 오류 순으로 다시 시도). 값 = 문서 루트에 걸 속성(CSS가 실행). */
export const TOPBAR_ATTRS = { bar: 'data-narrow-bar', notes: 'data-narrow-notes', error: 'data-narrow-error', shell: 'data-narrow-shell' };
export const TOPBAR_STAGES = [
  [], ['bar'], ['bar', 'notes'], ['bar', 'notes', 'error'],
  ['bar', 'shell'], ['bar', 'shell', 'notes'], ['bar', 'shell', 'notes', 'error'],
];
/** 가장 넓은 상태에서 시작해 넘치지 않는 첫 단계를 고른다(매번 처음부터 — 되돌아갈 수 없는 래칫이 없다). 모두 넘치면 가장 접힌 단계를 그대로 둔다. 반환 = 고른 단계의 플래그 배열. */
export function fitTopbar(root, over) {
  const apply = (flags) => { for (const [k, attr] of Object.entries(TOPBAR_ATTRS)) { if (flags.includes(k)) root.setAttribute(attr, ''); else root.removeAttribute(attr); } };
  let picked = TOPBAR_STAGES[TOPBAR_STAGES.length - 1];
  for (const flags of TOPBAR_STAGES) {
    apply(flags); picked = flags;
    if (!over()) break;
  }
  return picked;
}
/** 화면에 실제로 그려지는 마지막 자식 — display:none·크기 0은 건너뛰고, display:contents 래퍼(칩 자리)는 안쪽으로 들어간다. */
function lastRendered(el, getStyle) {
  const kids = [...el.children];
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i];
    const display = getStyle(k).display;
    if (display === 'none') continue;
    if (display === 'contents') { const inner = lastRendered(k, getStyle); if (inner) return inner; continue; }
    const r = k.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    return k;
  }
  return null;
}
/** 상단바가 넘치는가 — scrollWidth(+1 반올림 여유)에 더해, 마지막 자식의 오른쪽이 content-box 오른쪽(오른쪽 패딩 안쪽)을 0.5px 넘어서면 넘침이다
    (L3: scrollWidth 판정은 끝 패딩 침범을 못 봐 960 en에서 검색칸이 0.9px 화면 밖이었다). 배율(CSS zoom)이 있으면 상자 비율로 패딩을 환산한다. */
export function isTopbarOver(bar, getStyle = (el) => globalThis.getComputedStyle(el)) {
  if (bar.scrollWidth > bar.clientWidth + 1) return true;
  const last = lastRendered(bar, getStyle);
  if (!last) return false;
  const box = bar.getBoundingClientRect();
  const st = getStyle(bar);
  const scale = bar.offsetWidth ? box.width / bar.offsetWidth : 1; // 배율이 걸리면 좌표(rect)는 레이아웃 px보다 커진다
  const contentRight = box.right - ((parseFloat(st.paddingRight) || 0) + (parseFloat(st.borderRightWidth) || 0)) * scale;
  return last.getBoundingClientRect().right > contentRight + 0.5;
}
