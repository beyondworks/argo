// 문서함 전용 아이콘(16 그리드·1.5px — ui/Icon.jsx와 같은 문법). 첫 화면 묶음에 싣지 않으려고 여기 둔다.
const P = {
  upload: '<path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/>',
  download: '<path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"/>',
  drive: '<path d="M5.6 2.5h4.8l3.6 6.3-2.4 4.2H4.4L2 8.8z"/><path d="M5.6 2.5 9.2 8.8H14M10.4 2.5 4.4 13M2 8.8h7.2"/>',
  pdf: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5M5.3 11.8V9h1a.9.9 0 0 1 0 1.8h-1"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.6"/><circle cx="6" cy="6.6" r="1.1"/><path d="m3 12 3.6-3.4 2.4 2.2 1.7-1.4L13 11.6"/>',
  doc: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5M5.5 9h5M5.5 11.5h5"/>',
  other: '<path d="M4 2.5h5l3.5 3.5v7.5A1.5 1.5 0 0 1 11 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M9 2.5V6h3.5"/>',
  link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"/>',
  pin: '<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>',
};
export function FIcon({ name, size = 13, className = '' }) {
  return <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[name] ?? P.other }} />;
}
