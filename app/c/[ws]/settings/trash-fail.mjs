// 보관함 실패 분류 — JSX 없는 순수 함수(2차 검수 M3, 2026-10-05).
/** 'gone' = 서버가 "항목이 이미 사라졌다"(trash_item_gone)고 했다: 다시 눌러도 같은 결과이니 목록을 다시 읽어 그 항목을 뺀다. 그 밖(코드 없는 404 포함)은 'failed' — 목록은 그대로. */
export function trashFailKind(err) {
  return (err?.data?.errorCode ?? err?.errorCode) === 'trash_item_gone' ? 'gone' : 'failed';
}
