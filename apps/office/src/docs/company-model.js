// 회사 정보 모양 — 순수 함수(노드 테스트 공용). 읽기 창구는 company-info.js.

/** name 상호(서식 표기) · legalName 등록명 · bizNo 사업자등록번호 · ceo 대표자 · address 사업장 소재지 · openDate 개업일/등록일 · bizType 업태 · bizItem 종목
 *  manager 담당자 · phone 연락처 · email 이메일 · bank { name 은행, account 계좌번호, holder 예금주 } · logo 로고(그림 주소, 흰색 로고 권장) · seal 도장(그림 주소) */
export const FIELDS = ['name', 'legalName', 'bizNo', 'ceo', 'address', 'openDate', 'bizType', 'bizItem', 'manager', 'phone', 'email', 'logo', 'seal'];

// 예시 회사(전부 가상 — 번호·주소·연락처는 실제가 아니다)
const SEAL = (text) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect x="6" y="6" width="108" height="108" rx="10" fill="none" stroke="#c8102e" stroke-width="7"/><text x="60" y="56" font-family="serif" font-size="30" font-weight="700" fill="#c8102e" text-anchor="middle">${text.slice(0, 2)}</text><text x="60" y="92" font-family="serif" font-size="30" font-weight="700" fill="#c8102e" text-anchor="middle">${text.slice(2, 4)}</text></svg>`)}`;
export const SAMPLE_COMPANY = {
  beyondworks: {
    name: '비욘드웍스', legalName: '주식회사 비욘드웍스', bizNo: '000-00-00001', ceo: '김유건',
    address: '서울특별시 성동구 예시로 00, 0층 (예시동)', openDate: '2024-03-02 / 2024-03-04',
    bizType: '정보통신업, 전문·과학 및 기술서비스업', bizItem: '응용 소프트웨어 개발 및 공급업, 경영컨설팅업',
    manager: '김유건', phone: '02-000-0000', email: 'yoogeon@beyondworks.example',
    bank: { name: '예시은행', account: '000-000000-00-000', holder: '주식회사 비욘드웍스' }, logo: '', seal: SEAL('비욘드인'),
  },
  'lean-studio': {
    name: '린 스튜디오', legalName: '린 스튜디오', bizNo: '000-00-00002', ceo: '최민지', address: '경기도 예시시 예시로 00',
    openDate: '2025-01-02 / 2025-01-03', bizType: '정보통신업', bizItem: '영상 제작업', manager: '최민지', phone: '031-000-0000', email: 'minji@lean-studio.example',
    bank: { name: '예시은행', account: '000-0000-0000', holder: '린 스튜디오' }, logo: '', seal: SEAL('린스튜디'),
  },
  me: {
    name: '김유건', legalName: '김유건(개인)', bizNo: '', ceo: '김유건', address: '', openDate: '', bizType: '', bizItem: '',
    manager: '김유건', phone: '', email: 'yoogeon@beyondworks.example', bank: { name: '', account: '', holder: '' }, logo: '', seal: '',
  },
};

/** 트랙 C 회사 정보(getCompanyProfile) → 이 창구의 모양. 계좌는 첫 줄을 "은행 계좌번호 (예금주)"로 보고 그대로 둔다 */
export function fromProfile(p) {
  if (!p) return null;
  const acc = Array.isArray(p.accounts) ? p.accounts[0] : null;
  return { name: p.name, legalName: p.regName, bizNo: p.bizNo, ceo: p.ceo, address: p.address, openDate: p.openDate, bizType: p.bizType, bizItem: p.bizItem,
    manager: p.manager, phone: p.phone, email: p.email, bank: acc ? { name: acc.label ?? '', account: acc.value ?? '', holder: '' } : {}, logo: p.logo, seal: p.seal };
}
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pic = (v) => (typeof v === 'string' && /^(data:image\/(png|jpe?g|webp|svg\+xml)[;,]|https:\/\/|\/)/.test(v) ? v : '');

/** 어떤 원본이 와도 서식이 쓰는 모양으로 — 빈 칸은 빈 문자열(서식이 '계약 체결 시 확인'·빈 칸으로 처리) */
export function normalizeCompany(raw, fallbackName = '') {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bank = r.bank && typeof r.bank === 'object' ? r.bank : {};
  const name = str(r.name, 200) || str(fallbackName, 200);
  return {
    name, legalName: str(r.legalName, 200) || name, bizNo: str(r.bizNo, 20), ceo: str(r.ceo, 100), address: str(r.address),
    openDate: str(r.openDate, 100), bizType: str(r.bizType), bizItem: str(r.bizItem), manager: str(r.manager, 100), phone: str(r.phone, 50), email: str(r.email, 320),
    bank: { name: str(bank.name, 100), account: str(bank.account, 100), holder: str(bank.holder, 200) }, logo: pic(r.logo), seal: pic(r.seal),
  };
}

