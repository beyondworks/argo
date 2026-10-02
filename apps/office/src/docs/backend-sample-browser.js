// 예시 모드 저장소의 브라우저 연결 — IndexedDB(idb-keyval)·브라우저 안 서명본 합성·예시 업무 원장(거래 '계약' 넘기기).
import { get, set, del } from 'idb-keyval';
import { createSampleDocs } from './backend-sample.js';
import { loadSample, saveSample, applyBusiness } from '../business/sample-business.js';

async function compose(bundle) {
  const [{ loadFonts }, { composeSignedPdf }] = await Promise.all([import('./pdf/html-to-pdf.js'), import('./pdf/compose.js')]);
  const fonts = await loadFonts();
  return composeSignedPdf({ ...bundle, font: fonts.regular, bold: fonts.bold });
}

/** 서명 완료 → 연결된 거래가 견적 단계면 '계약'으로(같은 브라우저의 예시 원장). 이미 계약 이후면 그대로 */
async function confirmOrder(space, orderId, at) {
  const st = loadSample(localStorage, space);
  const order = st.orders.find((o) => o.id === orderId);
  if (!order) return 'missing';
  if (order.status !== 'draft') return `skipped:${order.status}`;
  applyBusiness(st, 'order.confirm', { id: orderId, at }, Date.parse(at));
  saveSample(localStorage, space, st);
  window.dispatchEvent(new Event('office:biz-refresh'));
  return 'confirmed';
}

export default createSampleDocs({ kv: { get, set, del }, compose, confirmOrder });
