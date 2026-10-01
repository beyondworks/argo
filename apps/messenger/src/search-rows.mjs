// 검색의 메시지 조회 — 실패를 빈 결과로 삼키지 않는다(검수 E: 연결이 끊기면 "1건"만 안내 없이 보여 글이 없다고 착각).
// run은 SEARCH_LIMIT+1건까지 읽어 오는 조회. 실패하면 원인을 갈라 알린다 — 'offline'(네트워크 오류) | 'error'(서버 오류·시간 초과 등).
// 모든 실패를 "연결이 끊겼다"고 하면 서버 문제 때 사용자가 연결만 확인하게 된다(#793 검수 MEDIUM-2). 원문은 report로만(진단 기록).
import { isNetworkFailure } from './net-errors.mjs';
export async function fetchSearchRows(run, limit, report = () => {}) {
  try {
    const found = await run();
    return { msgs: found.slice(0, limit), more: found.length > limit, failed: false };
  } catch (e) { report(e); return { msgs: [], more: false, failed: isNetworkFailure(e?.message) ? 'offline' : 'error' }; }
}
