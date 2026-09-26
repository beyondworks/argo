// 아이콘 — 메신저 시안 v2 스프라이트와 같은 문법(16 그리드 · 1.5px 스트로크 · 둥근 끝). 쓰는 것만 둔다.
const PATHS = {
  home: '<path d="M2.5 7 8 2.5 13.5 7v6a1 1 0 0 1-1 1h-3v-4h-3v4h-3a1 1 0 0 1-1-1z"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.8"/><path d="m2.5 5 5.5 4 5.5-4"/>',
  inbox: '<path d="M2 9.5h3.2l1 1.8h3.6l1-1.8H14"/><path d="M3.6 4h8.8L14 9.5v2.7a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.2V9.5z"/>',
  send: '<path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z"/>',
  draft: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>',
  archive: '<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.5h3"/>',
  doc: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5M5.5 9h5M5.5 11.5h5"/>',
  lock: '<rect x="3" y="7" width="10" height="7" rx="2.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  stamp: '<path d="M5.5 9V6.5a2.5 2.5 0 0 1 5 0V9M3 9h10v2.5H3zM4 13.5h8"/>',
  run: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
  check: '<path d="m3 8.5 3.2 3L13 4.5"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  file: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5"/>',
  book: '<path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5H4.5A1.5 1.5 0 0 0 3 14zM3 14a1.5 1.5 0 0 1 1.5-1.5H13V15H4.5A1.5 1.5 0 0 1 3 14z"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.6M12.6 8h1.6M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  trash: '<path d="M3 5h10M6.5 5V3.5h3V5M4.5 5l.6 8h5.8l.6-8M6.8 7.5v4M9.2 7.5v4"/>',
  dots: '<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>',
  caret: '<path d="m4 6 4 4 4-4"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  back: '<path d="m10 4-4 4 4 4"/>',
  grip: '<circle cx="6" cy="4" r=".9" fill="currentColor"/><circle cx="10" cy="4" r=".9" fill="currentColor"/><circle cx="6" cy="8" r=".9" fill="currentColor"/><circle cx="10" cy="8" r=".9" fill="currentColor"/><circle cx="6" cy="12" r=".9" fill="currentColor"/><circle cx="10" cy="12" r=".9" fill="currentColor"/>',
  share: '<path d="M8 10V2.5M5 5.5l3-3 3 3M3 9v3.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9"/>',
  globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2z"/>',
  link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  reply: '<path d="M6.5 4 3 7.5 6.5 11M3.5 7.5H10a3 3 0 0 1 3 3V12"/>',
  hand: '<path d="M2.5 8.5h6M6 5.5l3 3-3 3M11 3v11"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.8"/><path d="M6 3v10"/>',
  menu: '<path d="M3 5h10M3 8h10M3 11h10"/>',
  hash: '<path d="M6.5 2.5 5 13.5M11 2.5 9.5 13.5M2.5 6h11M2 10h11"/>',
  layout: '<rect x="2" y="2.5" width="5" height="5" rx="1.2"/><rect x="9" y="2.5" width="5" height="3" rx="1.2"/><rect x="9" y="7.5" width="5" height="6" rx="1.2"/><rect x="2" y="9.5" width="5" height="4" rx="1.2"/>',
  history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8"/><path d="M8 5v3l2 1.3"/>',
  template: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/><path d="M2.5 6h11M6 6v7.5"/>',
  resize: '<path d="M13 7v6H7M13 13 8.5 8.5"/>',
  person: '<circle cx="8" cy="5.5" r="2.7"/><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0"/>',
};

export function Icon({ name, size = 16, className = '', title }) {
  return (
    <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + (PATHS[name] ?? '') }} />
  );
}
