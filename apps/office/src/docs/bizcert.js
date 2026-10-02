// 사업자등록증 글자 → 갑(거래처) 칸 사전 채움(인트라넷 lib/docgen/bizcert.ts 그대로). 노이즈가 있으므로 최종 값은 사람이 화면에서 확인·수정한다.
// 오피스 추가: 같은 줄 값 뒤에 붙어 나오는 다음 라벨(예: "상호 ○○ 성명 홍길동")을 잘라낸다 — pdf 글자층은 한 줄로 이어 나오는 일이 많다.

const NEXT_LABEL = /\s+(?:성\s*명|대\s*표\s*자|생\s*년\s*월\s*일|법인\s*등록\s*번호|개\s*업\s*연\s*월\s*일|사업장\s*소재지|본\s*점\s*소재지|사업의\s*종류|업\s*태|종\s*목|등록\s*번호|사업자\s*등록\s*번호)[\s:：)]*.*$/;

function grab(text, labelRe) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    const after = lines[i].slice((m.index ?? 0) + m[0].length).replace(/^[:：)\s]+/, '').replace(NEXT_LABEL, '').trim();
    if (after) return after;
    if (i + 1 < lines.length && lines[i + 1]) return lines[i + 1].replace(NEXT_LABEL, '').trim();
  }
  return undefined;
}

/** → { company?, bizNo?, ceo?, address? } */
export function parseBizCert(text) {
  const t = String(text || '').replace(/\r/g, '');
  const bizNo = t.match(/\b\d{3}-\d{2}-\d{5}\b/)?.[0] ?? (() => { const d = t.match(/(?:등록\s*번호|사업자\s*번호)[\s:：]*(\d{3})\s*(\d{2})\s*(\d{5})/); return d ? `${d[1]}-${d[2]}-${d[3]}` : undefined; })();
  const company = grab(t, /상\s*호\s*\(?\s*법?\s*인?\s*명?\s*\)?/);
  const ceo = grab(t, /성\s*명\s*\(?\s*대?\s*표?\s*자?\s*\)?|대\s*표\s*자/);
  const address = grab(t, /사업장\s*소?재?지?|사업장의?\s*소재지|소\s*재\s*지/);
  return {
    company: company && company.length <= 40 ? company : undefined,
    bizNo,
    ceo: ceo && ceo.length <= 20 ? ceo : undefined,
    address: address && address.length >= 4 ? address : undefined,
  };
}
