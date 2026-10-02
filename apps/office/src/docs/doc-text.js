// 문서 서식 문구 — PDF·파일 이름·문서함 요약·감사 페이지에 들어가는 글자(인트라넷 서식 그대로 한국어).
// 화면 언어(ko/en)와 상관없이 문서는 한국어 서식이다 — 화면 글자는 docs-i18n.js, 서식 본문은 templates.js·esign-mail.js, 여기에는 나머지 짧은 문구.
export const DOC = {
  kind: { quote: '견적서', contract: '계약서' },
  titleSep: ' — ',
  defaultService: '본 용역',
  defaultDeliverable: '산출물',
  defaultOption: '옵션',
  contractTitle: (customer) => `${customer} 용역 계약서`,
  dealTitle: (customer) => `${customer} 견적`,
  untitledEsign: '무제 계약',
  signDate: (y, m, d) => `${y}년 ${m}월 ${d}일`, // 서명본 계약일자(서식 "2026년   월   일" 자리를 채운다)
  startBasis: { split: '착수금 지급일', full: '계약 체결일' },
  fileFallback: '문서',
  party: ['갑', '을', '병', '정', '무'],
  partyN: (n) => `제${n}자`,
  supplierFallback: '을',
  signedSuffix: '_서명본.pdf',
  signedTitle: (title) => `${title} (서명본)`,
  signedSummary: (title) => `[서명본] ${title}`,
  signedTag: '서명본',
  summary: { quote: (d) => `[견적서] ${d.customer} · ${d.title} · ${d.summary}`, contract: (d) => `[계약서] ${d.customer} · ${d.title} · ${d.serviceSummary}` },
  audit: {
    title: '전자서명 완료 증명', doc: (t) => `문서: ${t}`, completed: (at) => `완료 시각: ${at}`, signers: '서명자',
    signed: (at, ip) => `   서명: ${at}   IP: ${ip}`, integrity: '무결성', hash: '원본 문서 SHA-256:',
    footnote: '이 페이지는 서명 절차의 감사 기록으로 자동 생성되었습니다. (사설 전자서명)',
  },
};
/** 파일 이름에 쓰는 글자(숫자·영문·한글·._-) — 인트라넷 sanitize와 같다 */
export const SAFE_NAME_RE = /[^0-9A-Za-z가-힣._-]/g;
