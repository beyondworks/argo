// 읽기 실패 한 곳(OFC-08) — 실패를 '비어 있음·정상·모두 확인'으로 보이지 않게, 다시 시도 단추와 함께. 화면마다 같은 모양·같은 말.
// small = 홈 모듈 안(.mod-empty 크기), 아니면 화면 가운데(.empty-state). text를 주면 그 말(권한 없음처럼 다시 시도해도 같은 사유)
import { t } from '../core/i18n.js';

export function LoadFail({ onRetry, small = false, text }) {
  return <div className={small ? 'mod-empty load-fail' : 'empty-state load-fail'} role="alert"><p>{text ?? t('load.readFail')}</p>{onRetry && <button type="button" className="btn sm" onClick={onRetry}>{t('desktop.retry')}</button>}</div>;
}
