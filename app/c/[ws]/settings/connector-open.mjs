// 커넥터 '연결'의 인가 창 열기(2026-10-28 제보: Windows 0.1.118에서 구글 캘린더·Gmail '연결'을 눌러도 브라우저가 안 뜸).
// 데스크톱(Tauri) 웹뷰는 window.open을 조용히 무시한다(app/layout.jsx desktopLinkBridge 주석, 2026-07-16) — 그래서 앱에서는
// 시스템 브라우저 열기(plugin-opener openUrl, 로그인·결제 포털과 같은 길)를 쓴다. 브라우저 화면은 종전처럼 새 창.
// 반환: true = 열었다(또는 브라우저에 맡겼다), false = 앱에서 열기가 실패했다(호출부가 안내를 띄운다).
export async function openAuthUrl(url, { tauri, openUrl, windowOpen }) {
  if (!tauri) { windowOpen(url, '_blank', 'noopener,noreferrer'); return true; } // 동의는 사용자 계정 행위 — 새 창에서
  try { await openUrl(url); return true; } catch { return false; }
}
