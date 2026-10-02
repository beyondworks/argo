// 자동 분류 낱말(한국 서류 이름·본문과 맞춰 본다 — 화면에 나가지 않는 자료라 사전 밖 한글 검사에서 뺀다). 판정 순서는 model.js classify.
/** 이름에서 — 위에서부터 먼저 맞는 분류 */
export const RULES = [
  ['quote', /견적|quotation|\bquote\b|estimate/i],
  ['contract', /계약서|계약|contract|agreement|협약서|약정서|\bnda\b|서명본/i],
  ['bizcert', /사업자\s*등록\s*증|사업자등록|business\s*registration|개업\s*연월일/i],
  ['bankbook', /통장\s*사본|통장|bank\s*book|계좌\s*사본/i],
  ['evidence', /영수증|세금\s*계산서|계산서|거래\s*명세|invoice|receipt|증빙|청구서|입금\s*확인/i],
  ['card', /명함|business\s*card/i],
];
/** 본문에서 — 이름으로 못 정했을 때 */
export const BODY = [
  ['bizcert', (b) => /사업자\s*등록\s*증/.test(b) || (/등록\s*번호/.test(b) && /개업\s*연월일|법인\s*등록\s*번호/.test(b))],
  ['quote', (b) => /견\s*적\s*서|quotation/i.test(b)],
  ['contract', (b) => /계\s*약\s*서|contract agreement/i.test(b)],
  ['evidence', (b) => /세금\s*계산서|영\s*수\s*증|거래\s*명세서|receipt|invoice/i.test(b)],
  ['bankbook', (b) => /통장|계좌\s*번호|예금주/.test(b) && /은행|bank/i.test(b)],
];
export const PHONE = /(01[016789]|0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}/, EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
