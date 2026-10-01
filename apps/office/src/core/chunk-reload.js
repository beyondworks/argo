// 화면 파일을 못 받았을 때(유건 10/1 통합 검수) — 배포 뒤 옛 탭이 사라진 파일 이름을 찾거나 개발 서버가 504를 내면 지연 로드가 실패한다.
// 그 실패면 한 번만 새로 불러온다. 같은 탭에서 1분 안에 또 실패하면 다시 불러오지 않는다(반복 새로 고침 방지) — 화면에 안내를 둔다.
const KEY = 'office-chunk-reload';
export const isChunkError = (e) => /dynamically imported module|module script failed|preload CSS|Loading (CSS )?chunk/i.test(String(e?.message ?? e));
export function reloadOnce(error, store, now = Date.now()) {
  if (!isChunkError(error)) return false;
  try {
    const last = Number(store.getItem(KEY));
    if (last && now - last < 60_000) return false;
    store.setItem(KEY, String(now));
    return true;
  } catch { return false; } // 저장소를 못 쓰면(사생활 보호 창 등) 반복을 막을 수 없으니 자동으로는 다시 불러오지 않는다
}
