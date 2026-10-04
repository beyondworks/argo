// 열어 둔 페이지 최신화의 판정(16차) — 순수 함수만. 실제 읽기·창끼리 알리기는 core/page-live.js, 규칙 시험은 test/page-live.test.mjs.

/** 탭 복귀 판정 — 서버 판 번호가 더 크고 이 창에 안 저장한 편집이 없을 때만 다시 읽는다 */
export const shouldReload = ({ local, remote, busy }) => Number.isInteger(local) && Number.isInteger(remote) && remote > local && !busy;

/** 다른 창이 보낸 저장을 이 창에 반영할 값 — 반영하지 않으면 null.
 *  같은 계정(저장 범위)일 때만, 판 번호가 더 새것일 때만(예시 데이터는 서버가 없어 판이 늘지 않으니 고친 시각으로), 안 저장한 편집이 없을 때만 */
export function peerPatch(msg, page, { scope, busy }) {
  if (!msg || !page || msg.owner !== scope || msg.id !== page.id || busy) return null;
  const newer = msg.sample ? !!msg.updated && msg.updated > (page.updated ?? '') : Number.isInteger(msg.version) && msg.version > (page.version ?? 0);
  if (!newer) return null;
  return { title: msg.title ?? '', content: msg.content, version: msg.version ?? page.version, updated: msg.updated ?? page.updated, loadedAt: Date.now() }; // loadedAt이 바뀌면 열린 편집기가 새 본문으로 다시 뜬다
}

