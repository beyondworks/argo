// 화면 초안용 예시 데이터 — 서버·DB 연결 전(단계 S). P0 이후 Supabase(msgr_*·office_*)와 IMAP으로 바뀐다.
// 사람·회사·메일 주소는 전부 가상이다.
const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();

export const ME = { id: 'u-me', name: '김유건', email: 'yoogeon@beyondworks.example' };

export const PEOPLE = [{ name: '최민지', email: 'minji@beyondworks.example', role: 'edit' }];

export const SPACES = [
  { key: 'me', kind: 'me', name: '내 공간', role: 'owner' },
  { key: 'beyondworks', kind: 'org', name: '비욘드웍스', role: 'owner', members: 12, mark: 'B' },
  { key: 'lean-studio', kind: 'org', name: '린 스튜디오', role: 'member', members: 5, mark: 'L' },
];

export const CREWS = [
  { id: 'crew-luna', name: '루나', role: '영업', status: 'work' },
  { id: 'crew-otto', name: '오토', role: '리서치', status: 'idle' },
  { id: 'crew-mio', name: '미오', role: '디자인', status: 'idle' },
  { id: 'crew-hana', name: '하나', role: '고객 응대', status: 'ask' },
];

const doc = (...blocks) => ({ type: 'doc', content: blocks });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
const todo = (items) => ({ type: 'taskList', content: items.map(([done, text]) => ({ type: 'taskItem', attrs: { checked: done }, content: [p(text)] })) });
const ul = (items) => ({ type: 'bulletList', content: items.map((text) => ({ type: 'listItem', content: [p(text)] })) });

export const PAGES = [
  { id: 'pg-note', space: 'me', parent: null, title: '업무 노트', icon: 'doc', updated: ago(12),
    content: doc(h(1, '업무 노트'), p('이번 주에 챙길 것과 크루에게 맡긴 일을 한곳에 적는다.'), todo([[true, '거래처 3곳 견적 회신 확인'], [false, '10월 캠페인 초안 검토'], [false, '오피스 화면 초안 피드백 정리']])) },
  { id: 'pg-retro', space: 'me', parent: 'pg-note', title: '9월 회고', icon: 'doc', updated: ago(60 * 26),
    content: doc(h(1, '9월 회고'), h(2, '잘 된 것'), ul(['메신저 0.1.39 발행', '결재 카드 문장 개선']), h(2, '아쉬운 것'), ul(['메일 확인이 여전히 손으로 한다'])) },
  { id: 'pg-read', space: 'me', parent: null, title: '읽을거리', icon: 'doc', updated: ago(60 * 50), content: doc(h(1, '읽을거리'), p('')) },
  { id: 'pg-guide', space: 'beyondworks', parent: null, title: '회사 안내', icon: 'doc', updated: ago(60 * 5),
    content: doc(h(1, '회사 안내'), p('비욘드웍스에 오신 것을 환영합니다. 처음 오신 분은 온보딩 가이드부터 읽어 주세요.')) },
  { id: 'pg-onboard', space: 'beyondworks', parent: 'pg-guide', title: '온보딩 가이드', icon: 'doc', updated: ago(60 * 30),
    content: doc(h(1, '온보딩 가이드'), todo([[false, '메신저 설치하고 조직 초대 수락'], [false, '내 크루 한 명 만들기'], [false, '오피스에 업무 메일 연결']])) },
  { id: 'pg-sales', space: 'beyondworks', parent: null, title: '영업 매뉴얼', icon: 'doc', updated: ago(60 * 3),
    content: doc(h(1, '영업 매뉴얼'), p('첫 연락부터 계약까지의 흐름과 크루에게 맡길 수 있는 일을 정리했다.')) },
  { id: 'pg-discount', space: 'beyondworks', parent: 'pg-sales', title: '거래처별 할인율', icon: 'lock', restricted: true, updated: ago(60 * 70), content: doc(h(1, '거래처별 할인율'), p('관리자와 영업팀장만 볼 수 있다.')) },
  { id: 'pg-minutes', space: 'beyondworks', parent: null, title: '회의록', icon: 'doc', updated: ago(60 * 24), content: doc(h(1, '회의록'), p('')) },
  { id: 'pg-0925', space: 'beyondworks', parent: 'pg-minutes', title: '9/25 주간 회의', icon: 'doc', updated: ago(60 * 24),
    content: doc(h(1, '9/25 주간 회의'), h(2, '결정'), ul(['오피스 1차는 메일 연동과 기록판을 함께 낸다', '메신저 App Store 재제출']), h(2, '할 일'), todo([[false, '오피스 화면 초안 공유 — 유건'], [false, '견적 템플릿 정리 — 루나']])) },
  { id: 'pg-lean-home', space: 'lean-studio', parent: null, title: '스튜디오 규칙', icon: 'doc', updated: ago(60 * 90), content: doc(h(1, '스튜디오 규칙'), p('')) },
];

export const MAIL_FOLDERS = [
  { id: 'inbox', name: 'mail.inbox' }, { id: 'drafts', name: 'mail.drafts' }, { id: 'sent', name: 'mail.sent' }, { id: 'archive', name: 'mail.archive' },
];

export const MAILS = [
  { id: 'm1', folder: 'inbox', from: '박지현', addr: 'jihyun.park@hanbit-corp.example', subject: '10월 납품 견적 재요청드립니다', at: ago(18), unread: true,
    body: ['안녕하세요, 한빛코퍼레이션 박지현입니다.', '지난주 보내주신 견적서 잘 받았습니다. 수량이 1,200개에서 1,800개로 늘어날 예정이라 단가를 다시 받아볼 수 있을까요?', '가능하면 이번 주 금요일까지 회신 부탁드립니다.', '감사합니다.'],
    note: { crew: 'crew-luna', summary: '수량 1,200→1,800개 변경에 따른 단가 재견적 요청. 금요일까지 회신 요청.', todos: ['1,800개 기준 단가표 확인', '금요일 오전까지 재견적 초안'] } },
  { id: 'm2', folder: 'inbox', from: '정다은', addr: 'daeun@sori-studio.example', subject: '촬영 일정 조율 (10/7~10/9)', at: ago(64), unread: true,
    body: ['유건님 안녕하세요.', '다음 달 촬영 일정 후보를 보내드립니다. 10월 7일부터 9일 중 편하신 날을 알려주세요.', '장소는 성수동 스튜디오입니다.'] },
  { id: 'm3', folder: 'inbox', from: 'Stripe', addr: 'receipts@stripe.example', subject: '9월 결제 영수증', at: ago(60 * 5), unread: false,
    body: ['Your receipt from Beyondworks.', 'Amount paid: $12.00'] },
  { id: 'm4', folder: 'inbox', from: '이서준', addr: 'seojun.lee@nextfield.example', subject: 'Re: 파트너십 제안서 검토 결과', at: ago(60 * 9), unread: false,
    body: ['제안서 잘 검토했습니다.', '2페이지의 수익 배분 구조만 조정하면 내부 승인이 가능할 것 같습니다. 다음 주 화요일에 통화 가능하실까요?'],
    note: { crew: 'crew-luna', summary: '수익 배분 구조만 조정하면 승인 가능. 다음 주 화요일 통화 제안.', todos: ['수익 배분 대안 2안 준비', '화요일 통화 일정 잡기'] } },
  { id: 'm5', folder: 'inbox', from: '고객센터 자동 알림', addr: 'no-reply@beyondworks.example', subject: '새 문의 3건이 접수되었습니다', at: ago(60 * 22), unread: false,
    body: ['문의 #2041 결제 오류', '문의 #2042 계정 이전', '문의 #2043 환불 요청'] },
  { id: 'm6', folder: 'inbox', from: '한국세무회계', addr: 'office@kr-tax.example', subject: '3분기 부가세 신고 자료 요청', at: ago(60 * 30), unread: false,
    body: ['3분기 부가세 신고를 위해 매출·매입 자료를 10월 10일까지 보내주세요.'] },
  { id: 'm7', folder: 'sent', from: '나', addr: 'yoogeon@beyondworks.example', subject: '견적서 송부드립니다', at: ago(60 * 80), unread: false, body: ['견적서를 첨부합니다.'] },
];

export const APPROVALS = [
  { id: 'ap1', crew: 'crew-luna', space: 'beyondworks', channel: '영업', at: ago(9), risk: 'high',
    plain: '한빛코퍼레이션에 수정 견적서 메일을 보냅니다.', need: '그러기 위해 회사 Gmail에서 메일 1통을 보내야 합니다.',
    command: 'use_connector gmail.send_message {"to":"jihyun.park@hanbit-corp.example","subject":"[비욘드웍스] 10월 납품 수정 견적","attachments":["quote-1800.pdf"]}' },
  { id: 'ap2', crew: 'crew-hana', space: 'beyondworks', channel: '고객 응대', at: ago(35), risk: 'low',
    plain: '환불 요청 문의 #2043에 답변을 게시합니다.', need: '그러기 위해 고객센터 답변 1건을 등록해야 합니다.',
    command: 'post_reply {"ticket":2043,"template":"refund-7d"}' },
  { id: 'ap3', crew: 'crew-otto', space: 'beyondworks', channel: '리서치', at: ago(120), risk: 'low',
    plain: '경쟁사 가격표를 정리한 문서를 회사 위키에 올립니다.', need: '그러기 위해 조직 문서 1개를 새로 만들어야 합니다.',
    command: 'org_doc.create projects/competitor-pricing-2026-09.md' },
  { id: 'ap4', crew: 'crew-mio', space: 'lean-studio', channel: '디자인', at: ago(240), risk: 'low',
    plain: '10월 캠페인 배너 시안 3종을 공유 폴더에 올립니다.', need: '그러기 위해 구글 드라이브에 파일 3개를 올려야 합니다.',
    command: 'use_connector drive.upload ["banner-a.png","banner-b.png","banner-c.png"]' },
];

export const WORK = [
  { id: 'w1', space: 'beyondworks', goal: '한빛코퍼레이션 1,800개 기준 재견적', lead: 'crew-luna', status: 'running', started: ago(20), steps: '3/5', channel: '영업' },
  { id: 'w2', space: 'beyondworks', goal: '9월 고객 문의 유형 분석 보고서', lead: 'crew-hana', status: 'blocked', started: ago(60 * 3), steps: '2/4', channel: '고객 응대', blockedBy: '결재 대기' },
  { id: 'w3', space: 'beyondworks', goal: '경쟁사 5곳 가격 조사', lead: 'crew-otto', status: 'running', started: ago(60 * 5), steps: '4/5', channel: '리서치' },
  { id: 'w4', space: 'lean-studio', goal: '10월 캠페인 배너 시안', lead: 'crew-mio', status: 'running', started: ago(60 * 8), steps: '1/3', channel: '디자인' },
];

export const DECISIONS = [
  { id: 'd1', space: 'beyondworks', crew: 'crew-luna', plain: 'nextfield에 파트너십 제안서 메일 발송', result: 'approved', by: '김유건', at: ago(60 * 26) },
  { id: 'd2', space: 'beyondworks', crew: 'crew-hana', plain: '문의 #2031 결제 오류 답변 게시', result: 'approved', by: '김유건', at: ago(60 * 30) },
  { id: 'd3', space: 'beyondworks', crew: 'crew-otto', plain: '유료 데이터베이스 구독(월 $49)', result: 'rejected', by: '김유건', at: ago(60 * 50) },
  { id: 'd4', space: 'beyondworks', crew: 'crew-luna', plain: '거래처 12곳에 추석 인사 메일 발송', result: 'approved', by: '최민지', at: ago(60 * 80) },
];

export const OUTPUTS = [
  { id: 'f1', space: 'beyondworks', name: 'quote-hanbit-1800.pdf', crew: 'crew-luna', channel: '영업', bytes: 284000, at: ago(15) },
  { id: 'f2', space: 'beyondworks', name: 'competitor-pricing-2026-09.xlsx', crew: 'crew-otto', channel: '리서치', bytes: 91000, at: ago(60 * 2) },
  { id: 'f3', space: 'beyondworks', name: 'cs-inquiry-types-sept.md', crew: 'crew-hana', channel: '고객 응대', bytes: 12400, at: ago(60 * 6) },
  { id: 'f4', space: 'beyondworks', name: 'partnership-proposal-v3.pdf', crew: 'crew-luna', channel: '영업', bytes: 1840000, at: ago(60 * 27) },
  { id: 'f5', space: 'lean-studio', name: 'banner-draft-a.png', crew: 'crew-mio', channel: '디자인', bytes: 640000, at: ago(60 * 9) },
];

export const JOURNAL = [
  { date: '2026-09-26', space: 'beyondworks', entries: [
    { crew: 'crew-luna', text: '한빛코퍼레이션 재견적 요청을 받아 단가표 확인 중. 수정 견적서 발송 결재를 올림.' },
    { crew: 'crew-otto', text: '경쟁사 5곳 중 4곳 가격 수집 완료. 남은 1곳은 공개 가격표가 없어 문의 메일 필요.' },
    { crew: 'crew-hana', text: '문의 3건 분류. 환불 요청 1건은 답변 게시 결재 대기.' } ] },
  { date: '2026-09-25', space: 'beyondworks', entries: [
    { crew: 'crew-luna', text: 'nextfield 제안서 발송(승인됨). 회신 대기.' },
    { crew: 'crew-hana', text: '결제 오류 문의 답변 게시(승인됨).' } ] },
];
