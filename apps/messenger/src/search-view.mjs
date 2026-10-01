// 검색 화면이 보일 안내를 고른다(순수) — 조회 중 / 첫 안내 / 일부만 보임 / 하나도 못 찾음 / 결과 없음.
// 실패했는데 "결과가 없습니다"라고 하면 글이 없다고 착각한다. 결과가 하나도 없는 실패는 "일부"가 아니라 "검색하지 못했습니다" 계열로 가른다(#793 검수 LOW-3).
export function searchView({ res, busy, total, phone = false }) {
  if (!res) return { loading: !!busy, hintKey: busy ? null : phone ? 'search.hint.phone' : 'search.hint', noticeKey: null, noneKey: null };
  const off = res.failed === 'offline';
  const noticeKey = !res.failed ? null : total > 0 ? (off ? 'search.partial' : 'search.partial.error') : (off ? 'search.failed' : 'search.failed.error');
  return { loading: false, hintKey: null, noticeKey, noneKey: !res.failed && !total ? 'search.none' : null };
}
