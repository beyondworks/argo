// 검색의 메시지 조회 — 실패를 빈 결과로 삼키지 않는다(검수 E: 연결이 끊기면 "1건"만 안내 없이 보여 글이 없다고 착각).
// run은 SEARCH_LIMIT+1건까지 읽어 오는 조회. 실패하면 failed=true로 알리고 원문은 report로만 넘긴다(진단 기록).
export async function fetchSearchRows(run, limit, report = () => {}) {
  try {
    const found = await run();
    return { msgs: found.slice(0, limit), more: found.length > limit, failed: false };
  } catch (e) { report(e); return { msgs: [], more: false, failed: true }; }
}
