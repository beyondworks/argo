// 인트라넷·Notion 원본의 한글 이름 → 오피스 값(트랙 C). 화면 문자열이 아니라 원본 글을 알아보는 표라 사전 파일에 둔다.
// 회사 정보 항목 이름(공백·괄호·대소문자 무시하고 전체가 같을 때) → 서식 칸 key
// 회사 정보 항목 이름에 이 낱말이 들어 있으면 계좌로 보고 크루에게 보내는 글에 값을 싣지 않는다(core/crew-items.js, 17차 A 검수 MEDIUM-2)
export const ACCOUNT_LABEL_WORDS = ['계좌', '예금주', 'account', 'iban'];
export const COMPANY_KEY_LABELS = {
  name: ['상호', '상호명', '회사명', '회사이름', '법인명', '상호(법인명)', 'company', 'companyname', 'name'],
  reg_name: ['등록명', '등록상호', '사업자등록상호', 'registeredname'],
  ceo: ['대표자', '대표', '대표이사', '대표자명', '성명(대표자)', 'ceo', 'representative'],
  biz_no: ['사업자등록번호', '사업자번호', '사업자등록no', 'businessregistrationnumber', 'brn', 'bizno'],
  corp_no: ['법인등록번호', '법인번호', 'corporateregistrationnumber'],
  open_date: ['개업일', '개업연월일', '사업자등록일', '개업일/사업자등록일', '설립일', 'opendate'],
  address: ['주소', '사업장주소', '사업장소재지', '소재지', '본점소재지', 'address'],
  biz_type: ['업태', 'businesstype'],
  biz_item: ['종목', 'businessitem'],
  tax_email: ['세금계산서이메일', '계산서이메일', '세금계산서메일', 'taxinvoiceemail'],
  manager: ['담당자', '담당', '실무담당자', 'contactperson', 'manager'],
  phone: ['전화', '전화번호', '대표전화', '대표번호', '연락처', 'phone', 'tel'],
  fax: ['팩스', '팩스번호', 'fax'],
  email: ['이메일', '대표이메일', '메일', 'email', 'e-mail'],
  seal: ['도장', '회사도장', '직인', '법인인감', '인감', 'seal'],
  logo: ['로고', '회사로고', 'logo'],
  website: ['홈페이지', '웹사이트', '사이트', 'website', 'homepage', 'url'],
};
export const CATEGORY_FROM_KO = { 기본정보: 'basic', 계좌: 'bank', 연락처: 'contact', 세무: 'tax', 기타: 'other' };
export const SCOPE_FROM_KO = { 주간: 'week', 월간: 'month', 연간: 'year' };
export const TYPE_FROM_KO = { 대표: 'ceo', 직원: 'staff', 에이전트: 'agent' };
export const DATE_UNITS = { year: '년', month: '월', day: '일' };
