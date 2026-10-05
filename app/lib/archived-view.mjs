import { failureReason } from './error-text.mjs';
// 보관한 회사 되돌리기 화면의 순수 판정 — JSX 없이 node --test가 직접 검증한다(test/archived-view.test.mjs).
/** 되돌리기 실패 분류(UL1) — 'exists' = 같은 id 회사가 이미 목록에 있다(409 archive_restore_exists): 다시 눌러도 같은 결과이니 그 행은 '열기'로 바꾼다.
    그 밖(순단·500·보관본 없음)은 'failed' = 잠시 뒤 다시 시도. err = api()가 던지는 오류({ data: { errorCode }, status }) 또는 fetch 예외. */
export function restoreFailKind(err) {
  return err?.data?.errorCode === 'archive_restore_exists' ? 'exists' : 'failed';
}

/** 보관 목록의 한 행 상태 — 'exists'(되돌릴 수 없고 열 수 있다) | 'restorable'. blocked = 이번에 409를 받은 archiveId들, existingIds = 지금 목록에 있는 회사 id들(홈이 안다). */
export function archivedRowState(item, { blocked, existingIds } = {}) {
  if (blocked?.has(item?.archiveId) || existingIds?.has(item?.wsId)) return 'exists';
  return 'restorable';
}

/** 홈 입구에 보일 개수 — 목록을 못 받았거나(null) 비었으면 0 = 입구 없음. */
export function archivedEntryCount(items) {
  return Array.isArray(items) ? items.length : 0;
}

/** 되돌리기 실패 안내 문구(2차 L1) — 같은 회사가 이미 있으면(exists) 사전 문구 그대로, 그 밖은 "되돌리지 못했습니다 — {사유}". 사유는 failureReason(원문 대신 사전·일반 문구). */
export function restoreFailMessage(err, t) {
  const reason = failureReason(err, t);
  return restoreFailKind(err) === 'exists' ? reason : t('settings.archived.restoreFailWhy', { msg: reason });
}

/** 되돌리기 결과 안내({ ok, text, href }) — 카드가 만들고, 홈은 카드가 사라져도(마지막 보관 회사를 되돌리면 개수 0·온보딩에서 다른 자리로 다시 마운트) 안내가 남게 자기 상태에 둔다(2차 L2). */
export function restoreNote(item, result, t) {
  return { ok: true, text: t('settings.archived.restored', { name: item.name }), href: `/c/${result?.wsId ?? item.wsId}` };
}
