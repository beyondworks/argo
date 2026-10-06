// Postgres·PostgREST·네트워크 오류 분류 — 다시 해 볼 만한 일시 오류와 다시 해도 같은 결과일 결정적 오류를 가른다(순수 모듈).
// 일시 오류만 좁게 나열하고 나머지는 전부 결정적으로 본다: 목록에 없던 결정적 오류(PGRST204 열 없음·22P05 NUL·42P10·42703 …)를 일시로 잘못 보면 15초 틱마다 같은 실패를 되풀이하기 때문이다
// (검수 #fix-cross 4차 M-1). 일시: 코드 없음(fetch failed·시간 초과)·네트워크 코드(ECONNRESET 등)·PGRST0xx(연결)·PGRST3xx(JWT — 세션 갱신 뒤 풀린다)·08xxx(연결)·40001(직렬화 실패)·40P01(교착)·40003(문 완료 여부 모름)·
// 53xxx(자원 부족)·55P03(잠금 못 얻음)·57014(문 시간 초과)·57P01·57P03·57P05(관리자 종료·지금 연결 불가·유휴 세션 시간 초과)·5xx·402·408·429.
// P0001(raise exception — 함수가 일부러 거절)·P0002·0A000(지원 안 함)·XX000(내부 오류)은 같은 입력이면 같은 결과라 결정적이다(검수 5차). 스키마 어긋남(앱이 마이그레이션보다 먼저 나감): PGRST202·204·205·42883·42703·42P01.
// 합친 뒤 queue.mjs(rc/fix-argo)의 isPermanentQueueError·isSchemaSkewError와 하나로 합친다 — 같은 목록·같은 뜻이어야 한다(총괄이 합침).
const codeOf = (e) => String(e?.code ?? '').trim();
const TRANSIENT_CODE = /^(PGRST0\d\d|PGRST3\d\d|08[0-9A-Z]{3}|40001|40P01|40003|53[0-9A-Z]{3}|55P03|57014|57P01|57P03|57P05|5\d\d|402|408|429|E[A-Z_]+|UND_ERR_[A-Z_]+)$/;
const SKEW_CODE = /^(PGRST20[245]|42883|42703|42P01)$/;
/** 다음 틱에 다시 해 볼 오류인가 — 코드가 없으면(fetch failed·AbortError·시간 초과) 일시 */
export function isTransientDbError(e) {
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true;
  const code = codeOf(e);
  return code === '' || TRANSIENT_CODE.test(code);
}
/** 스키마 어긋남(앱이 마이그레이션보다 먼저 나감)인가 */
export const isSchemaSkewError = (e) => SKEW_CODE.test(codeOf(e));
/** 다시 해도 같은 결과일 오류(일시가 아닌 전부) */
export const isDeterministicDbError = (e) => !isTransientDbError(e);
