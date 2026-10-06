// 회사 셸 조회 실패 처리 — JSX 없는 순수 함수(node --test가 직접 import해 검증한다).
// F3(2026-10-05): 회사 정보 조회가 한 번만 실패해도(순단·401·500) 화면 전체가 '회사를 찾을 수 없습니다'로 바뀌었다.

/** 진짜 없음인가 — 서버가 404 company_not_found(authmsg.mjs 코드)라고 말한 경우만. 상태 숫자만 보지 않는다(프록시 404 등). */
export function isCompanyMissing(err) {
  return err?.data?.errorCode === 'company_not_found';
}

/** 조회 실패 뒤 셸 상태 — 진짜 없음이면 '찾을 수 없음' 화면, 그 밖은 이미 보던 화면을 그대로 두고(다음 폴·다시 시도에서 회복),
    처음부터 받은 것이 없으면 '불러오지 못함 + 다시 시도' 화면. */
export function nextCompanyData(prev, err) {
  if (isCompanyMissing(err)) return { missing: true };
  if (prev?.company) return prev;
  return { loadError: true };
}

/** 못 읽은 크루 카드 안내 재료(L2, 2026-10-05) — 회사 응답의 broken({ count, names })이 있고 1개 이상일 때만, 아니면 null(안내 없음). */
export function brokenCardsOf(data) {
  const b = data?.broken;
  if (!b || !Number.isFinite(b.count) || b.count < 1) return null;
  return { count: b.count, names: Array.isArray(b.names) ? b.names : [] };
}

/** 못 읽은 카드의 파일 위치 목록(2차 L7) — 이름마다 `agents/<이름>.md`(회사 폴더 기준). 앞 8개만 보이고 나머지는 개수로. */
export function brokenCardFiles(broken, max = 8) {
  const names = Array.isArray(broken?.names) ? broken.names : [];
  const shown = names.slice(0, max);
  return { files: shown.map((n) => `agents/${n}.md`), more: Math.max(0, (broken?.count ?? 0) - shown.length) };
}
