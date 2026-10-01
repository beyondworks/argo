// 바탕화면 파일 드롭 — 본체 app/c/[ws]/crew/[slug]/page.jsx의 검증된 판정을 그대로 옮겼다.
/** dragover 단계는 내용을 못 읽으므로 타입·kind로만 판정한다. 맥 WKWebView는 public.* UTI로 광고하기도 한다. */
export const dragHasFiles = (dt) => {
  const types = [...(dt?.types ?? [])];
  if (types.includes('Files')) return true;
  if ([...(dt?.items ?? [])].some((i) => i.kind === 'file')) return true;
  return types.some((ty) => ty.startsWith('public.') || ty.startsWith('image/') || ty === 'application/x-moz-file');
};

/** 화면 캡처 썸네일처럼 저장 전(promise) 드래그는 files가 비고 items[].getAsFile()로만 잡힌다 — 두 경로 모두 훑는다. */
export const filesFromTransfer = (dt) => {
  const direct = [...(dt?.files ?? [])].filter(Boolean);
  if (direct.length) return direct;
  return [...(dt?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
};

export const MAX_FILE = 50 * 1024 * 1024; // 1차 상한 50MB(유건 확정 2026-09-26)
// 산출물 열기(유건 9/30) — 그림·문서는 그 자리에서 보이고 나머지는 받기. 메신저 첨부는 mime이 빈 경우가 많아 확장자로도 본다.
// svg는 스크립트를 품을 수 있어 받기만 한다.
const EXT = { image: /\.(png|jpe?g|gif|webp|avif|bmp)$/i, md: /\.(md|markdown)$/i, text: /\.(txt|csv|tsv|json|log|ya?ml)$/i, pdf: /\.pdf$/i };
export function fileKind(name = '', mime = '') {
  const m = (mime ?? '').toLowerCase();
  if (m && m !== 'application/octet-stream') {
    if (m.startsWith('image/') && m !== 'image/svg+xml') return 'image';
    if (m === 'text/markdown') return 'md';
    if (m.startsWith('text/') || m === 'application/json') return EXT.md.test(name) ? 'md' : 'text';
    if (m === 'application/pdf') return 'pdf';
    return 'other';
  }
  return Object.keys(EXT).find((k) => EXT[k].test(name)) ?? 'other';
}
export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
