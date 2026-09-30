// 패밀리 페이지 아이콘 — 글자 기호(✓ ↗ →) 대신 같은 굵기(1.6)의 SVG만 쓴다(유건 원칙: 아이콘은 SVG, 굵기·크기 통일).
const PATHS = {
  check: 'M4 10.5l4 4 8-9',
  plus: 'M10 4v12M4 10h12',
  external: 'M8 4h8v8M16 4L5 15',
  arrow: 'M4 10h12M11 5l5 5-5 5',
  mail: 'M3 5.5h14v9H3zM3.5 6l6.5 5 6.5-5',
  page: 'M5.5 3h6l3.5 3.5V17h-9.5zM11.5 3v3.5H15M8 10h4.5M8 13h4.5',
  chat: 'M3.5 4.5h13v9h-7l-4 3v-3h-2z',
  handoff: 'M4 14.5c3-6 6-8 12-8M12.5 3l3.5 3.5-3.5 3.5',
  translate: 'M3 5h8M7 3.5V5M9.5 5c-.6 3-2.6 5.4-5.5 6.8M5.5 7.5c1 1.7 2.4 3 4 3.8M10.5 16.5l3-7.5 3 7.5M11.6 14h3.8',
  stamp: 'M8 3.5h4v4.5l3 2.5v2H5v-2L8 8zM4 15.5h12',
};

// OS 로고 — 선 아이콘이 아니라 채운 모양(24 격자). 다운로드 버튼 앞에 쓴다.
const BRANDS = {
  apple: 'M12.15 6.9c-.95 0-2.42-1.08-3.96-1.04-2.04.03-3.91 1.18-4.96 3.01-2.12 3.68-.55 9.1 1.52 12.09 1.01 1.45 2.21 3.09 3.79 3.04 1.52-.07 2.09-.99 3.94-.99 1.83 0 2.35.99 3.96.95 1.64-.03 2.68-1.48 3.68-2.95 1.16-1.69 1.64-3.33 1.66-3.42-.04-.01-3.18-1.22-3.22-4.86-.03-3.04 2.48-4.49 2.6-4.56-1.43-2.09-3.62-2.32-4.39-2.38-2-.16-3.68 1.09-4.61 1.09zM15.53 3.83c.84-1.01 1.4-2.43 1.25-3.83-1.21.05-2.66.81-3.53 1.82-.78.9-1.45 2.34-1.27 3.71 1.34.1 2.72-.69 3.56-1.7z',
  windows: 'M0 3.45 9.75 2.1v9.45H0zM10.95 1.95 24 0v11.4H10.95zM0 12.6h9.75v9.45L0 20.7zM10.95 12.6H24V24l-13.05-1.8z',
  android: 'M2.5 19a9.5 8.5 0 0 1 19 0zM7.5 14.5a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0zM14 14.5a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0zM5.6 7.3l1.2-.7 2 3.4-1.2.7zM18.4 7.3l-1.2-.7-2 3.4 1.2.7z',
};

export default function Icon({ name, size = 14 }) {
  if (BRANDS[name]) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" style={{ flex: 'none' }}>
        <path d={BRANDS[name]} />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
