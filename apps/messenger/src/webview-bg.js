// 모바일 웹뷰 바탕 — 창 설정(tauri.ios/android.conf.json backgroundColor)은 네이티브 시작 화면과 HTML 첫 페인트 사이의
// 흰(다크 모드면 검은) 화면을 덮으려고 스플래시 색(#1F1E1B)으로 시작한다. 그 색이 그대로 남으면 라이트 테마에서 키보드·회전·바운스로
// 드러나는 자리가 어둡게 보인다(반대 검토 #7). 스플래시가 닫히면 지금 테마의 바탕으로 바꾸고, 테마가 바뀌면 따라간다.
// 값이 같으면 다시 부르지 않는다. 권한: capabilities/mobile.json core:webview:allow-set-webview-background-color.
export function followThemeBackground(win = window, doc = document) {
  const webview = win.__TAURI__?.webview?.getCurrentWebview?.();
  if (!webview?.setBackgroundColor) return false;
  let last = '';
  const apply = () => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(win.getComputedStyle(doc.body).backgroundColor || '');
    if (!m || (m[4] != null && Number(m[4]) === 0)) return; // 투명(테마 바탕 미정)이면 건드리지 않는다
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    const key = rgb.join(',');
    if (key === last) return;
    last = key;
    Promise.resolve(webview.setBackgroundColor(rgb)).catch(() => {});
  };
  apply();
  new win.MutationObserver(apply).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  win.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', apply);
  return true;
}
