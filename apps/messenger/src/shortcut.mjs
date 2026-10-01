// 단축키 표시 — 맥은 ⌘, 그 밖의 OS는 Ctrl. 검색 칸 안내가 OS와 상관없이 '(⌘K)'로 고정이던 것(검수 E, 2026-10-01).
// 동작은 이미 metaKey || ctrlKey 둘 다 받는다 — 표시만 맞춘다.
export function shortcutLabel(key, nav = globalThis.navigator ?? {}) {
  const platform = String(nav.userAgentData?.platform || nav.platform || '');
  return /mac|iphone|ipad/i.test(platform) ? `⌘${key}` : `Ctrl+${key}`;
}
