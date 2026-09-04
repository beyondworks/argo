// 메신저 아이콘 세트 — 시안 v2(design/system-v2.css) 스프라이트(쓰는 것만). 16 그리드 · 1.5px 스트로크 · 둥근 끝.
// <Sprite/>를 앱 루트에 한 번 두고, <I name="clip"/>로 참조한다(Argo ui.jsx의 Icon과 별개 — 이 앱의 어휘: 도장·회의·채널).
const PATHS = {
  hash: '<path d="M6.5 2.5 5 13.5M11 2.5 9.5 13.5M2.5 6h11M2 10h11"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="2.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  caret: '<path d="m4 6 4 4 4-4"/>',
  memory: '<path d="M8 2l1.4 4.3L14 8l-4.6 1.7L8 14l-1.4-4.3L2 8l4.6-1.7z"/>',
  dots: '<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  clip: '<path d="m13.5 7.5-5.7 5.7a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3L6.4 11a1.1 1.1 0 0 1-1.6-1.6l5.2-5.2"/>',
  at: '<circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8"/>',
  up: '<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
  check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
  stamp: '<path d="M5.5 9V6.5a2.5 2.5 0 0 1 5 0V9M3 9h10v2.5H3zM4 13.5h8"/>',
  reply: '<path d="M6.5 4 3 7.5 6.5 11M3.5 7.5H10a3 3 0 0 1 3 3V12"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  doc: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5M5.5 9h5M5.5 11.5h5"/>',
  menu: '<path d="M3 5h10M3 8h10M3 11h10"/>',
  star: '<path d="M8 0l1.9 5.6L16 8l-6.1 2.4L8 16l-1.9-5.6L0 8l6.1-2.4z"/>',
  memoff: '<path d="M3 3l10 10M6.5 4.5A3.5 3.5 0 0 1 12 7v1.5M4 7a3.5 3.5 0 0 0 5.5 4.5M5 13h6"/>',
  out: '<path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H6M9.5 11 13 8l-3.5-3M13 8H6"/>',
};
export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>{Object.entries(PATHS).map(([k, d]) => <symbol key={k} id={`mi-${k}`} viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: d }} />)}</defs>
    </svg>
  );
}
export function I({ name, size = 16, className = '', style }) {
  return <svg className={`mi ${className}`} width={size} height={size} style={style} aria-hidden="true"><use href={`#mi-${name}`} /></svg>;
}
export const STAR_D = 'M8 0l1.9 5.6L16 8l-6.1 2.4L8 16l-1.9-5.6L0 8l6.1-2.4z';
