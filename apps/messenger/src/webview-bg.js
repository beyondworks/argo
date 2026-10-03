// 모바일 웹뷰 바탕 — 창 설정(tauri.ios/android.conf.json backgroundColor)은 네이티브 시작 화면과 HTML 첫 페인트 사이의
// 흰(다크 모드면 검은) 화면을 덮으려고 스플래시 색(#1F1E1B)으로 시작한다. 그 색이 그대로 남으면 라이트 테마에서 키보드·회전·바운스로
// 드러나는 자리가 어둡게 보인다(반대 검토 #7). 스플래시가 닫히면 지금 테마의 바탕으로 바꾸고, 테마가 바뀌면 따라간다.
// 값이 같으면 다시 부르지 않는다. 권한: capabilities/mobile.json core:webview:allow-set-webview-background-color.
// iOS는 따로 간다 — Tauri의 웹뷰 바탕 명령(set_webview_background_color)은 데스크톱에만 등록돼 iOS에서는 호출이 조용히 실패했고,
// 라이트 테마에서 키보드 위 막대 주변·키보드 둥근 모서리 뒤로 스플래시 색이 검은 띠로 남았다(유건 실기기 제보 2026-10-03).
// iOS는 앱 플러그인 ios-webview(src-tauri/plugins/ios-webview, 권한 capabilities/ios-webview.json)가 웹뷰·스크롤 뷰·부모 뷰를 함께 칠한다.
export function backgroundSetter(win = window, platform) {
  if (platform === 'ios') {
    const invoke = win.__TAURI__?.core?.invoke;
    return invoke ? ([red, green, blue]) => invoke('plugin:ios-webview|set_background', { red, green, blue }) : null;
  }
  const webview = win.__TAURI__?.webview?.getCurrentWebview?.();
  return webview?.setBackgroundColor ? (rgb) => webview.setBackgroundColor(rgb) : null;
}

export function followThemeBackground(win = window, doc = document, platform) {
  const setBackground = backgroundSetter(win, platform);
  if (!setBackground) return false;
  let last = '';
  const apply = () => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(win.getComputedStyle(doc.body).backgroundColor || '');
    if (!m || (m[4] != null && Number(m[4]) === 0)) return; // 투명(테마 바탕 미정)이면 건드리지 않는다
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    const key = rgb.join(',');
    if (key === last) return;
    last = key;
    Promise.resolve(setBackground(rgb)).catch(() => {});
  };
  apply();
  new win.MutationObserver(apply).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  win.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', apply);
  return true;
}
