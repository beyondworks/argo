// 문서함 아이콘 — ui/Icon.jsx(Google Material Symbols)로 그린다. Google Drive 표시만 상표 모양이라 그림으로 남긴다.
import { Icon } from '../ui/Icon.jsx';

const NAME = { upload: 'upload', download: 'download', pdf: 'pdf', image: 'image', doc: 'doc', other: 'file', link: 'link', pin: 'pin' };

export function FIcon({ name, size = 13, className = '' }) {
  // .ico 상자는 1em이라 글꼴 아이콘과 같이 fontSize로 크기를 준다
  if (name === 'drive') return (
    <svg className={`ico ${className}`} style={{ fontSize: size }} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.6 2.5h4.8l3.6 6.3-2.4 4.2H4.4L2 8.8z" /><path d="M5.6 2.5 9.2 8.8H14M10.4 2.5 4.4 13M2 8.8h7.2" />
    </svg>
  );
  return <Icon name={NAME[name] ?? 'file'} size={size} className={className} />;
}
