// 공개 링크에서 빼는 블록 — 서버 office_strip(가장 최근 정의: supabase/migrations/20261002201700_office_files.sql)과 같은 목록·같은 규칙.
// 서버가 공개 페이지 본문을 이미 걸러서 주고, 이 함수는 예시 데이터 모드(서버 없음)의 공개 화면이 같은 모양이 되게 한다. 두 목록이 같은지는 test/public-doc.test.mjs가 잠근다.
// 토글·콜아웃·표·2열/3열(16차)은 빼지 않는다 — 공개 본문으로 그대로 보이고, 그 안에 든 비공개 블록·파일 블록 등은 어느 깊이에 있든 빠진다.
export const PUBLIC_DROP = ['recordCard', 'mailRef', 'privateBlock', 'moduleGrid', 'fileRef'];

/** 문서 노드 → 공개용 노드(안쪽까지). 모듈 격자는 빈 노드로(서버와 같다) */
export function stripPublic(n) {
  if (n?.type === 'moduleGrid') return {};
  if (!n || typeof n !== 'object' || !Array.isArray(n.content)) return n;
  return { ...n, content: n.content.filter((c) => !PUBLIC_DROP.includes(c?.type ?? '')).map(stripPublic) };
}
