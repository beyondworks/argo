// 첨부 파일의 Storage 객체 키 규칙 — 메신저·오피스는 이 모듈을, 게이트웨이(src/gateway/msgr.mjs)는 같은 규칙의 Node 사본을 쓴다.
// Storage 키는 ASCII 안전 문자만 — 한글·대괄호·공백이 든 이름은 Supabase Storage가 "Invalid key"로 거절한다(실사고 2026-09-11 밤: "[패스트캠퍼스 _ 265263] … 커리큘럼.csv").
// 표시 이름은 msgr_attachments.name에 원문 그대로 남기고, 키는 메시지 폴더 안에서 순번으로 구분한다(같은 이름 두 개도 덮어쓰지 않게).
export function storageKey(name, index = 0) {
  const raw = String(name ?? '');
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) : '';
  const stem = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'file';
  return `${index}-${stem}${ext ? `.${ext}` : ''}`;
}
