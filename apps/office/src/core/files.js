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
export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
