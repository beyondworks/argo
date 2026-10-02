// 견적서·계약서 서식 — 인트라넷 lib/docgen/quote.ts·contract.ts의 CSS·배너·표·조항 문구를 그대로 옮기고,
// 한 회사 전용 값(상호·사업자번호·대표자·주소·담당자·연락처·로고)만 회사 정보(src/docs/company-info.js → 트랙 C core/company.js)에서 읽는다.
// 순수 함수(문자열 → HTML) — 브라우저 PDF 생성기(pdf/html-to-pdf.js)와 미리보기, 노드 테스트가 같이 쓴다.
import { won, isoDay, docTotals, ROWS_PER_PAGE } from './model.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const amount = (it) => Math.round(it.unitPrice) * Math.round(it.qty);

// 글꼴: 인트라넷은 macOS 크롬의 시스템 글꼴로 그렸다. 오피스는 브라우저 안에서 그리고 같은 글꼴을 PDF에 넣어야 해서
// Pretendard(인트라넷 서명본 한글 글꼴과 같은 파일)를 앞에 둔다 — 줄 바꿈·폭이 PDF와 화면에서 같아진다.
/** 미리보기 틀에 넣을 글꼴(앱이 이미 받은 가변 글꼴 — 같은 금형이라 폭이 PDF용 고정 글꼴과 같다) */
export const PREVIEW_FONT_CSS = "@font-face{font-family:'Pretendard';font-weight:45 920;src:url('/fonts/PretendardVariable.woff2') format('woff2-variations');}";
const FONT = `"Pretendard", -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;

function supplierName(co) { return co.legalName && co.legalName !== co.name ? `${esc(co.name)} (등록명: ${esc(co.legalName)})` : esc(co.name); }
function banner(co, tag) {
  const mark = co.logo ? `<img src="${esc(co.logo)}" alt="${esc(co.name)}" crossorigin="anonymous">` : `<span class="logo-text">${esc(co.name)}</span>`;
  return `<div class="banner">${mark}<div class="doc-tag">${tag}</div></div>`;
}
const contactOf = (co) => [co.manager, co.phone, co.email].filter(Boolean).map(esc).join(' / ');
const vatLabel = (items) => (docTotals(items).allTaxable ? '부가세 (10%)' : '부가세');

function optionTable(option, top) {
  if (!option || !option.rows?.length) return '';
  return `
    <h2 class="section"${top ? ' style="margin-top:0"' : ''}>${esc(option.title)}</h2>
    <table>
      <tr><th style="width:22%; white-space:nowrap">항목</th><th style="width:16%; text-align:right; white-space:nowrap">단가</th><th>조건</th></tr>
${option.rows.map((r) => `      <tr><td style="white-space:nowrap">${esc(r.name)}</td><td style="text-align:right; white-space:nowrap">${won(r.unitPrice)}원/인</td><td>${esc(r.condition)}</td></tr>`).join('\n')}
    </table>`;
}

const BASE_CSS = `
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: ${FONT}; color: #111; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { position: relative; width: 210mm; height: 297mm; } /* 잘라내지 않는다 — 조용히 사라지는 것보다 보이는 편이 낫다(인트라넷 quote.ts:134) */
  .page + .page { page-break-before: always; }
  .banner { background: #000; padding: 9mm 18mm; display: flex; align-items: center; justify-content: space-between; }
  .banner img { height: 18px; display: block; filter: brightness(0) invert(1); } /* 어두운 배너 — 어떤 색 로고든 흰색으로(인트라넷 로고는 흰색 SVG) */
  .banner .logo-text { color: #fafafa; font-size: 15px; font-weight: 700; letter-spacing: -0.2px; line-height: 18px; }
  .banner .doc-tag { color: #fafafa; font-size: 11px; letter-spacing: 3px; font-weight: 600; }
  .footer-bar { position: absolute; left: 18mm; right: 18mm; display: flex; justify-content: space-between; font-size: 8.5px; color: #999; border-top: 1px solid #ddd; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 2mm; }
  th { background: #e6e6e6; text-align: left; border-bottom: 2px solid #000; font-weight: 700; }
  td { border-bottom: 1px solid #d5d5d5; vertical-align: top; }
  tr:nth-child(even) td { background: #f7f7f7; }
  td .desc { display:block; color:#666; margin-top:3px; }
  tr.subtotal td { font-weight: 700; border-top: 1px solid #000; background: #ececec; }
`;

/** 견적서 — 1장 공급자·담당자 / 2..N장 견적 내역(ROWS_PER_PAGE행씩, 합계는 마지막 조각) / 마지막 장 진행 조건·비고(인트라넷 quote.ts:3-9) */
export function renderQuoteHtml(q, co, { fontCss = '' } = {}) {
  const date = q.date || isoDay();
  const valid = q.validUntil || isoDay(14);
  const { supply, vat, total } = docTotals(q.items);
  const chunks = [];
  for (let i = 0; i < Math.max(q.items.length, 1); i += ROWS_PER_PAGE) chunks.push(q.items.slice(i, i + ROWS_PER_PAGE));
  const pageCount = 2 + chunks.length;
  const footer = (n) => `<div class="footer-bar"><span>${esc(co.name)}</span><span>${esc(q.customer)} · ${n} / ${pageCount}</span></div>`;
  const page = (inner, n) => `<div class="page" data-page="${n}">\n  ${banner(co, 'QUOTATION')}\n  <div class="content">\n${inner}\n  </div>\n  ${footer(n)}\n</div>`;
  const row = (it) => {
    const desc = it.desc ? `<span class="desc">${esc(it.desc)}</span>` : '';
    return `      <tr><td>${esc(it.name)}${desc}</td><td class="num">${won(it.unitPrice)}원</td><td class="num">${won(it.qty)}</td><td class="num">${won(amount(it))}원</td></tr>`;
  };
  const termItems = (q.terms?.length ? q.terms : ['세부 진행 조건은 협의 후 확정합니다.']).map((x) => `        <li>${esc(x)}</li>`).join('\n');
  const noteItems = [
    '<li>상기 금액은 부가가치세(10%) 별도 산정 기준입니다.</li>',
    ...(q.notes ?? []).map((n) => `<li>${esc(n)}</li>`),
    ...(q.validUntil === '' ? [] : [`<li>본 견적서의 유효기간은 발행일로부터 2주(${esc(valid)})입니다.</li>`]),
  ].map((li) => `        ${li}`).join('\n');
  const cell = (v) => (v ? esc(v) : '');

  const infoPage = `    <h1 class="title">견적서 — ${esc(q.title)}</h1>
    <div class="subtitle">작성일 ${esc(date)} · 수신: ${esc(q.customer)}${q.summary ? ` (${esc(q.summary)})` : ''}</div>

    <h2 class="section">공급자 정보 (사업자등록증 기준)</h2>
    <table>
      <tr><th style="width:30%">항목</th><th>내용</th></tr>
      <tr><td>상호</td><td>${supplierName(co)}</td></tr>
      <tr><td>사업자등록번호</td><td>${cell(co.bizNo)}</td></tr>
      <tr><td>대표자</td><td>${cell(co.ceo)}</td></tr>
      <tr><td>사업장 소재지</td><td>${cell(co.address)}</td></tr>
      <tr><td>개업일 / 사업자등록일</td><td>${cell(co.openDate)}</td></tr>
      <tr><td>업태</td><td>${cell(co.bizType)}</td></tr>
      <tr><td>종목</td><td>${cell(co.bizItem)}</td></tr>
    </table>

    <h2 class="section">담당자 정보</h2>
    <table>
      <tr><th style="width:30%">항목</th><th>내용</th></tr>
      <tr><td>담당자</td><td>${cell(co.manager)}</td></tr>
      <tr><td>연락처</td><td>${cell(co.phone)}</td></tr>
      <tr><td>이메일</td><td>${cell(co.email)}</td></tr>
    </table>`;

  const itemPages = chunks.map((chunk, i) => {
    const last = i === chunks.length - 1;
    const head = `    <h2 class="section" style="margin-top:0">견적 내역${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''}</h2>`;
    const totals = last ? `
      <tr class="subtotal"><td colspan="3">공급가액 소계</td><td class="num">${won(supply)}원</td></tr>
      <tr><td colspan="3">${vatLabel(q.items)}</td><td class="num">${won(vat)}원</td></tr>
      <tr class="total"><td colspan="3">합계</td><td class="num">${won(total)}원</td></tr>` : '';
    return page(`${head}
    <table>
      <tr><th>항목</th><th class="num" style="width:19%">단가</th><th class="num" style="width:9%">수량</th><th class="num" style="width:19%">금액</th></tr>
${chunk.map(row).join('\n')}${totals}
    </table>${last ? optionTable(q.option, false) : ''}`, 2 + i);
  }).join('\n\n');

  const tailPage = page(`    <div class="block">
      <h2 class="section" style="margin-top:0">진행 조건</h2>
      <ul class="terms">
${termItems}
      </ul>
    </div>

    <div class="block">
      <h2 class="section">비고</h2>
      <ul class="terms">
${noteItems}
      </ul>
    </div>`, pageCount);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>견적서 — ${esc(q.customer)}</title>
<style>${fontCss}${BASE_CSS}
  .content { padding: 12mm 18mm 0; }
  h1.title { font-size: 21px; margin: 0 0 2mm; letter-spacing: -0.3px; }
  .subtitle { color: #666; font-size: 10.5px; margin-bottom: 9mm; }
  h2.section { font-size: 12.5px; margin: 8mm 0 2.5mm; border-bottom: 2px solid #000; padding-bottom: 2mm; letter-spacing: 0.3px; }
  table { font-size: 10.5px; }
  th { padding: 12px 16px; }
  td { padding: 10px 14px; }
  td .desc { font-size:9px; line-height:1.45; }
  th.num, td.num { text-align: right; white-space: nowrap; }
  tr.total td { font-weight: 700; border-top: 2px solid #000; background: #d6d6d6; font-size: 11.5px; }
  ul.terms { font-size: 10.5px; padding-left: 18px; line-height: 1.7; margin: 2mm 0; }
  .block { page-break-inside: avoid; }
  .footer-bar { bottom: 10mm; padding-top: 3mm; }
</style>
</head>
<body>

${page(infoPage, 1)}

${itemPages}

${tailPage}

</body>
</html>`;
}

const PAYMENT_TEXT = {
  split: '다음과 같이 분할 지급한다: 착수금 50%(계약 체결 시), 잔금 50%(제6조에 따른 검수 완료 후)',
  full: '일시에 100% 지급한다',
};
const IP_TITLE = { service: '제8조 (지적재산권)', product: '제8조 (지적재산권 및 사용권)' };
const IP_TEXT = {
  service: '본 용역으로 신규 구축되는 산출물의 소유권 및 지적재산권은 대금 완납을 조건으로 갑에게 귀속된다. 다만 을이 본 용역 이전부터 보유하였거나 본 용역과 독립하여 개발한 프레임워크·라이브러리·도구·노하우 등 기존 자산에 대한 권리는 을에게 유보되며, 을은 이를 다른 사업에 계속 활용할 수 있다.',
  product: '본 계약에 따라 납품되는 을의 제품(소프트웨어·구성요소·문서 일체)에 대한 지적재산권은 을에게 유보되며, 갑에게는 갑의 내부 업무를 위한 비독점적 사용권만 부여된다. 갑은 을의 사전 서면 동의 없이 본 제품을 제3자에게 재판매·양도·재라이선스하거나 역설계·복제·2차적 저작물 작성을 할 수 없다.',
};
export const BLANK_TEXT = '계약 체결 시 사업자등록증 확인 후 기입';
const blank = (v) => (v && String(v).trim() ? esc(v) : `<span class="blank">${BLANK_TEXT}</span>`);

/** 계약서 — 3쪽 고정(인트라넷 contract.ts). sealSupplier: 을 대표자 칸에 회사 도장을 찍어 둔다(을이 따로 서명하지 않아도 되게 — 오피스 추가) */
export function renderContractHtml(c, co, { fontCss = '', sealSupplier = false } = {}) {
  const date = c.date || isoDay();
  const startBasis = c.startBasis || (c.payment === 'split' ? '착수금 지급일' : '계약 체결일');
  const scopeItems = (c.scope.length ? c.scope : ['세부 범위는 협의 후 별첨으로 확정한다.']).map((x) => `          <li>${esc(x)}</li>`).join('\n');
  const option = optionTable(c.option, true);
  const article4Top = option ? '' : ' style="margin-top:0"';
  const { supply, vat, total } = docTotals(c.items);
  const rows = c.items.map((it) => {
    const desc = it.desc ? `<span class="desc">${esc(it.desc)}</span>` : '';
    return `      <tr><td>${esc(it.name)}${desc}</td><td style="text-align:right">${won(it.unitPrice)}원</td><td style="text-align:right">${won(it.qty)}</td><td style="text-align:right">${won(amount(it))}원</td></tr>`;
  }).join('\n');
  const footer = (n) => `<div class="footer-bar"><span>${esc(co.name)}</span><span>${n} / 3</span></div>`;
  const seal = sealSupplier && co.seal ? `<img class="seal" src="${esc(co.seal)}" alt="" crossorigin="anonymous">` : '';
  const pad = '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>계약서 — ${esc(c.customer)}</title>
<style>${fontCss}${BASE_CSS}
  .content { padding: 13mm 18mm 0; }
  h1.title { font-size: 20px; margin: 0 0 2mm; letter-spacing: -0.3px; text-align: center; }
  .subtitle { color: #666; font-size: 10px; margin-bottom: 6mm; text-align: center; }
  h2.section { font-size: 11.5px; margin: 5mm 0 2.5mm; border-bottom: 2px solid #000; padding-bottom: 1.5mm; letter-spacing: 0.3px; }
  table { font-size: 10px; }
  th { padding: 8px 12px; }
  td { padding: 8px 12px; }
  td .desc { font-size:8.5px; line-height:1.5; }
  tr.total td { font-weight: 700; border-top: 2px solid #000; background: #d6d6d6; font-size: 10.5px; }
  .blank { color: #bbb; }
  ol.articles { font-size: 10px; line-height: 1.75; padding-left: 0; margin: 1mm 0 3mm; list-style: none; }
  ol.articles > li { margin-bottom: 2.2mm; }
  ol.articles ul { padding-left: 16px; margin: 1mm 0; list-style: disc; }
  .preamble { font-size: 10px; line-height: 1.8; margin-bottom: 4mm; }
  .sign-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 4mm; }
  .sign-table th { background: #111; color: #fff; text-align: center; padding: 8px; border: 1px solid #111; }
  .sign-table td { border: 1px solid #ccc; padding: 8px 10px; vertical-align: top; }
  .sign-table .label { width: 20%; background: #f2f2f2; font-weight: 700; }
  .sign-space { height: 16mm; position: relative; }
  .sign-space .seal { position: absolute; width: 15mm; height: 15mm; left: 34mm; top: 0.5mm; opacity: 0.92; }
  .note { font-size: 8.5px; color: #666; border-top: 1px solid #bbb; padding-top: 2.5mm; margin-top: 5mm; line-height: 1.6; }
  .footer-bar { bottom: 8mm; padding-top: 2.5mm; }
</style>
</head>
<body>

<div class="page" data-page="1">
  ${banner(co, 'CONTRACT')}
  <div class="content">
    <h1 class="title">${esc(c.title)}</h1>
    <div class="subtitle">작성일 ${esc(date)}${c.summary ? ` · ${esc(c.summary)}` : ''}</div>

    <div class="preamble">
      "${esc(c.customer)}"(이하 "갑"이라 한다)과 "${esc(co.name)}"(이하 "을"이라 한다)은 ${esc(c.serviceSummary)}(이하 "본 용역")에 관하여 다음과 같이 계약(이하 "본 계약")을 체결한다.
    </div>

    <h2 class="section">계약 당사자</h2>
    <table>
      <tr><th style="width:12%">구분</th><th style="width:16%">항목</th><th>갑 (발주자)</th><th>을 (수행자)</th></tr>
      <tr><td rowspan="5" style="font-weight:700">기본정보</td><td>상호</td><td>${esc(c.party.company)}</td><td>${supplierName(co)}</td></tr>
      <tr><td>사업자등록번호</td><td>${blank(c.party.bizNo)}</td><td>${esc(co.bizNo)}</td></tr>
      <tr><td>대표자</td><td>${blank(c.party.ceo)}</td><td>${esc(co.ceo)}</td></tr>
      <tr><td>사업장 소재지</td><td>${blank(c.party.address)}</td><td>${esc(co.address)}</td></tr>
      <tr><td>담당자 / 연락처</td><td>${blank(c.party.contact)}</td><td>${contactOf(co)}</td></tr>
    </table>

    <h2 class="section">제1조 (목적)</h2>
    <ol class="articles">
      <li>본 계약은 갑이 을에게 ${esc(c.purpose)}을 위탁하고, 을이 이를 수행함에 있어 양 당사자의 권리·의무 및 필요한 사항을 정함을 목적으로 한다.</li>
    </ol>

    <h2 class="section">제2조 (용역의 범위)</h2>
    <ol class="articles">
      <li>본 용역의 범위는 다음 각 호와 같다.
        <ul>
${scopeItems}
        </ul>
      </li>
${c.scopeNote ? `      <li>${esc(c.scopeNote)}</li>` : ''}
    </ol>

    <h2 class="section">제3조 (계약금액)</h2>
    <table>
      <tr><th>항목</th><th style="text-align:right">단가</th><th style="text-align:right">수량</th><th style="text-align:right">금액</th></tr>
${rows}
      <tr class="subtotal"><td colspan="3">공급가액 소계</td><td style="text-align:right">${won(supply)}원</td></tr>
      <tr><td colspan="3">${vatLabel(c.items)}</td><td style="text-align:right">${won(vat)}원</td></tr>
      <tr class="total"><td colspan="3">계약금액 합계</td><td style="text-align:right">${won(total)}원</td></tr>
    </table>
  </div>
  ${footer(1)}
</div>

<div class="page" data-page="2">
  ${banner(co, 'CONTRACT')}
  <div class="content">${option}
    <h2 class="section"${article4Top}>제4조 (대금 지급 방법)</h2>
    <ol class="articles">
      <li>갑은 을에게 제3조의 계약금액을 ${PAYMENT_TEXT[c.payment] ?? PAYMENT_TEXT.split}.</li>
      <li>을은 대금 청구 시 세금계산서를 발행하며, 갑은 세금계산서 수취 후 지체 없이 대금을 지급한다.</li>
    </ol>

    <h2 class="section">제5조 (이행기간 및 방법)</h2>
    <ol class="articles">
      <li>본 용역의 착수일은 ${esc(startBasis)}로 하며, ${esc(c.schedule || '세부 일정은 상호 협의하여 확정한다')}.</li>
      <li>이행 방식은 ${esc(c.method || '상호 협의한 방식')}으로 진행함을 원칙으로 한다.</li>
    </ol>

    <h2 class="section">제6조 (산출물 인도 및 검수)</h2>
    <ol class="articles">
      <li>을은 이행기간 종료 시 ${esc(c.deliverable)}을 갑에게 인도·시연한다.</li>
      <li>갑은 인도일로부터 7일 이내에 검수하여 결과를 을에게 통지하며, 위 기간 내 이의를 제기하지 않으면 검수를 완료한 것으로 본다.</li>
    </ol>

    <h2 class="section">제7조 (하자보수)</h2>
    <ol class="articles">
      <li>검수 완료 후 산출물이 정상 작동하지 않는 경우, 을은 무상으로 하자를 보수한다.</li>
      <li>갑의 요구사항 변경, 갑측 시스템·데이터·계정 환경 변경, 제3자 서비스(API·플랫폼·계정 등) 정책 변경으로 인한 오작동은 하자보수 범위에서 제외하며, 별도 협의로 처리한다.</li>
    </ol>

    <h2 class="section">${IP_TITLE[c.ip] ?? IP_TITLE.service}</h2>
    <ol class="articles">
      <li>${IP_TEXT[c.ip] ?? IP_TEXT.service}</li>
    </ol>

    <h2 class="section">제9조 (비밀유지의무)</h2>
    <ol class="articles">
      <li>양 당사자는 본 계약 수행 과정에서 알게 된 상대방의 영업상·기술상 비밀을 상대방의 서면 동의 없이 제3자에게 누설하거나 본 계약 목적 외로 사용하지 아니한다.</li>
      <li>본 조의 의무는 본 계약 종료 후에도 2년간 유효하다.</li>
    </ol>
  </div>
  ${footer(2)}
</div>

<div class="page" data-page="3">
  ${banner(co, 'CONTRACT')}
  <div class="content">
    <h2 class="section" style="margin-top:0">제10조 (계약의 해지)</h2>
    <ol class="articles">
      <li>일방 당사자가 본 계약상 의무를 위반하고 상대방으로부터 서면 시정 요구를 받은 날로부터 7일 이내에 이를 시정하지 아니하는 경우, 상대방은 본 계약을 해지할 수 있다.</li>
      <li>계약 해지 시 을은 해지 시점까지 수행한 용역에 상응하는 대가를 정산받으며, 갑은 기지급 대금 중 미수행 부분에 대해 반환을 청구할 수 있다.</li>
    </ol>

    <h2 class="section">제11조 (손해배상 및 면책)</h2>
    <ol class="articles">
      <li>일방 당사자의 귀책사유로 상대방에게 손해가 발생한 경우, 귀책 당사자는 상대방에게 발생한 직접 손해를 배상한다.</li>
      <li>천재지변, 불가항력적 사유로 인한 이행 지연 또는 불능에 대하여는 어느 당사자도 책임을 지지 않는다.</li>
    </ol>

    <h2 class="section">제12조 (분쟁해결)</h2>
    <ol class="articles">
      <li>본 계약과 관련하여 분쟁이 발생하는 경우 양 당사자는 상호 협의하여 원만히 해결하도록 노력한다.</li>
      <li>협의로 해결되지 않는 경우 관할 법원은 민사소송법에 따른 법원으로 한다.</li>
    </ol>

    <h2 class="section">제13조 (기타)</h2>
    <ol class="articles">
      <li>본 계약에 명시되지 않은 사항은 관계 법령 및 상관례에 따르며, 필요 시 양 당사자 협의하여 별도 서면으로 정한다.</li>
      <li>본 계약은 계약서 2부를 작성하여 갑과 을이 각각 서명 또는 날인 후 1부씩 보관한다.</li>
    </ol>

    <table class="sign-table">
      <tr><th style="width:8%">구분</th><th style="width:36%">갑 (발주자)</th><th style="width:56%">을 (수행자)</th></tr>
      <tr><td class="label">회사명</td><td>${esc(c.party.company)}</td><td>${esc(co.name)}</td></tr>
      <tr><td class="label">대표자</td><td class="sign-space" data-sign="0">${c.party.ceo ? esc(c.party.ceo) : ''}${pad}(서명 또는 인)</td><td class="sign-space" data-sign="1">${esc(co.ceo)}${pad}(서명 또는 인)${seal}</td></tr>
      <tr><td class="label">계약일자</td><td colspan="2">${esc(date.slice(0, 4))}년 &nbsp;&nbsp;월 &nbsp;&nbsp;일</td></tr>
    </table>

    <div class="note">
      · 갑의 기본정보(상호·대표자·주소·사업자등록번호)는 사업자등록증 기재사항을 기준으로 합니다.<br>
      ${c.note ? `· ${esc(c.note)}<br>` : ''}· 계약금액은 부가가치세 별도 기준입니다.
    </div>
  </div>
  ${footer(3)}
</div>

</body>
</html>`;
}

/** 문서 → HTML 한 번에 */
export function renderDocHtml(kind, input, co, opts) { return kind === 'contract' ? renderContractHtml(input, co, opts) : renderQuoteHtml(input, co, opts); }
