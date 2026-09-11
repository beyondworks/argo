// 첨부 목록 수용 — 파일 선택창과 드래그앤드롭이 같은 규칙을 쓴다(유건 제보 2026-09-11 밤: 드롭 안 됨·붙인 파일 취소 불가).
// 크기 상한 초과는 거절 목록으로 돌려주고(보낸 사람이 이유를 알게), 같은 파일(이름+크기)은 한 번만, 기존 목록에 누적한다.
export function acceptFiles(existing, incoming, max) {
  const rejected = []; const next = [...existing];
  for (const f of incoming ?? []) {
    if (!f || typeof f.size !== 'number') continue;
    if (f.size > max) { rejected.push(f); continue; }
    if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
    next.push(f);
  }
  return { files: next, rejected };
}
export const withoutFile = (files, target) => files.filter((f) => f !== target);

// Storage 키는 ASCII 안전 문자만 — 한글·대괄호·공백이 든 이름은 Supabase Storage가 "Invalid key"로 거절한다(실사고 2026-09-11 밤: "[패스트캠퍼스 _ 265263] … 커리큘럼.csv").
// 표시 이름은 msgr_attachments.name에 원문 그대로 남기고, 키는 메시지 폴더 안에서 순번으로 구분한다(같은 이름 두 개도 덮어쓰지 않게).
export function storageKey(name, index = 0) {
  const raw = String(name ?? '');
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) : '';
  const stem = (dot > 0 ? raw.slice(0, dot) : raw).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || 'file';
  return `${index}-${stem}${ext ? `.${ext}` : ''}`;
}
