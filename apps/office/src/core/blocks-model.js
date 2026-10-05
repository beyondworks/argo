// 페이지 블록의 작은 규칙(16차) — 의존성 없는 순수 값만. 편집기 스키마(pages/page-blocks.js)와 읽기 화면(ui/DocView.jsx)이 같이 쓴다.
// 읽기 화면은 공개 페이지에서도 쓰이므로 편집기(tiptap) 코드를 끌어오지 않게 여기에 따로 둔다.

/** 링크 주소 — http(s)·mailto·tel만 연다 */
export const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;
export const safeHref = (href) => (typeof href === 'string' && SAFE_HREF.test(href.trim()) ? href.trim() : null);

/** 콜아웃 아이콘 — 앱 아이콘 글꼴에 있는 이름만(이모지 아님). 모르는 값은 안내(info) */
export const CALLOUT_ICONS = ['info', 'star', 'pin', 'target', 'megaphone', 'check', 'lock', 'calendar', 'run', 'book', 'doc', 'mail', 'person', 'building', 'chart', 'link', 'folder', 'tag'];
export const calloutIcon = (v) => (CALLOUT_ICONS.includes(v) ? v : 'info');

/** 자동 링크 판정 — tiptap 기본(형식 있는 주소는 링크, IP 숫자·점 없는 호스트는 아님)에 더해 앞 형식 없는 '이름.zip'·'이름.mov'(파일 이름 모양의
 *  최상위 도메인)는 링크로 만들지 않는다 — 공개 화면·보낸 메일에 남의 도메인 링크로 나갔다(16차 검수 LOW 10) */
export function shouldAutoLink(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.includes('@'))) return true;
  const host = (url.includes('@') ? url.split('@').pop() : url).split(/[/?#:]/)[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.')) return false;
  return !/\.(zip|mov)$/i.test(host);
}

/** 표 칸 병합 수 — 1~100(큰 값이 읽기·공개 화면을 멈추지 않게, 16차 검수 LOW 5) */
export const cellSpan = (v) => Math.min(100, Math.max(1, Math.floor(Number(v)) || 1));

/** 붙여 넣은 HTML의 링크 주소를 편집기가 읽기 전에 고친다 — 'naver.com' → 'https://naver.com'. normalize가 null이면 그대로(편집기 허용 검사가 거른다).
 *  앞 형식 없이 저장되면 ⌘+누르기·읽기 화면·보낸 메일에서 깨진 상대 주소가 되었다(16차 검수 LOW 6) */
export const fixPastedHrefs = (html, normalize) => (html ? html.replace(/(<a\b[^>]*?\shref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, (m, pre, d, s, u) => {
  const v = normalize(d ?? s ?? u ?? '');
  return v ? `${pre}"${v.replace(/"/g, '&quot;')}"` : m;
}) : html);
