// listDocs 캐시 저장소 — hub.mjs(읽기·채우기)와 memindex.mjs invalidatePath(무효화)·workspace.mjs archiveCompany(폐기)가
// 같이 쓴다. 별도 모듈인 이유: memindex가 hub를 import하면 순환(hub → workspace, memindex → workspace)이 생긴다.
// 구조: wsId → Map(절대 파일 경로 → { key, doc }). 프로세스 안 캐시(Next 번들 사본마다 따로).
export const docCache = new Map();
/** 진행 중 첫 로드 — 같은 회사의 동시 호출이 전수 읽기를 배수로 내지 않게(검수 #538 MEDIUM-4: 동시 3회 = 3배). */
export const docCacheInflight = new Map();
/** 파일 하나(absFile) 또는 회사 전체(absFile 없음)를 캐시에서 뺀다. mtime을 보존한 채 내용을 바꾸는 쓰기 경로
    (memory.mjs writeKeepingMtime·sync.mjs 수신)가 memindex.invalidatePath로 부른다 — 키(mtime·size·ctime·ino)만으로는 못 잡는 경우의 정본 무효화. */
export function dropDocCache(wsId, absFile = null) {
  if (!absFile) { docCache.delete(wsId); return; }
  docCache.get(wsId)?.delete(absFile);
}
