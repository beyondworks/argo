// Notion 이관 시험용 예시 원본(가상) — Notion API 응답 모양 그대로(data source query 결과·블록 목록). 실제 워크스페이스 값은 하나도 없다.
// notion-migrate.mjs --fixture 와 test/notion-plan.test.mjs가 쓴다.
const rt = (s, a = {}) => (s ? [{ type: 'text', plain_text: s, text: { content: s, link: a.link ? { url: a.link } : null }, href: a.link ?? null, annotations: { bold: !!a.bold, italic: !!a.italic, strikethrough: false, underline: false, code: !!a.code, color: 'default' } }] : []);
const title = (s) => ({ type: 'title', title: rt(s) });
const text = (s) => ({ type: 'rich_text', rich_text: rt(s) });
const select = (s) => ({ type: 'select', select: s ? { name: s } : null });
const page = (id, properties, created = '2026-08-01T01:00:00.000Z', edited = created) => ({ object: 'page', id, created_time: created, last_edited_time: edited, properties });

export const parents = [page('p-dev', { 'Entry name': title('개발') }), page('p-sales', { 'Entry name': title('영업') })];

const entry = (id, name, date, extra = {}) => page(id, {
  'Entry name': title(name), Date: { type: 'date', date }, Status: { type: 'status', status: { name: extra.status ?? 'Not Started' } },
  Relation: { type: 'relation', relation: extra.rel ? [{ id: extra.rel }] : [] }, Category: select(extra.cat ?? null), Completed: { type: 'checkbox', checkbox: !!extra.done },
  'Location (Entry)': text(extra.loc ?? ''), Notes: text(extra.notes ?? ''), 우선순위: select(extra.pri ?? null), 자동화: text(''), 담당: text(extra.agent ?? ''), 출처: select(extra.src ?? null),
}, extra.created ?? '2026-08-20T00:00:00.000Z', extra.edited ?? '2026-08-25T09:00:00.000Z');

export const calendar = [
  entry('c-1', '고객사 미팅', { start: '2026-09-10T14:00:00.000+09:00', end: '2026-09-10T15:30:00.000+09:00' }, { loc: '강남 사무실', rel: 'p-sales', notes: '견적 설명' }),
  entry('c-2', '세미나', { start: '2026-09-15', end: '2026-09-16' }, { loc: '코엑스' }),
  entry('c-3', '랜딩 문구 수정', { start: '2026-09-03', end: null }, { rel: 'p-dev', status: 'Completed', pri: 'High', agent: 'claude_code', edited: '2026-09-03T08:00:00.000Z' }),
  entry('c-4', '제안서 초안', { start: '2026-09-20', end: '2026-09-25' }, { status: 'In Progress', cat: '제안서', notes: '1차 초안까지' }),
  entry('c-5', '세금계산서 확인', { start: '2026-08-31', end: null }, { done: true, edited: '2026-09-01T02:00:00.000Z' }),
  entry('c-6', '아이디어 모음', null, { status: 'Pending' }),
  entry('c-7', '주간 회의', { start: '2026-09-07T10:00:00.000+09:00', end: null }, { rel: 'p-dev' }),
];

const ci = (id, item, value, cat, notes = '') => page(id, { 항목: title(item), 값: text(value), 분류: select(cat), 메모: text(notes) });
export const company = [
  ci('k-1', '상호명', '(주)예시컴퍼니', '기본정보'), ci('k-2', '대표자', '홍길동', '기본정보'), ci('k-3', '사업자등록번호', '000-00-00000', '기본정보'),
  ci('k-4', '주소', '서울특별시 가상구 예시로 1', '기본정보'), ci('k-5', '주거래 계좌', '예시은행 000-000-000000', '계좌', '견적서용'),
  ci('k-6', '대표번호', '02-000-0000', '연락처'), ci('k-7', '이메일', 'hello@example.test', '연락처'), ci('k-8', '업태', '정보통신업', '세무'),
  ci('k-9', '전화', '010-0000-0000', '연락처', '대표번호와 같은 칸 — 두 번째는 자유 항목으로'), ci('k-10', '와이파이', 'guest / 비밀 아님', null),
];

const rep = (id, t, scope, subject, type, period, s, extra = {}) => page(id, {
  제목: title(t), 평가범위: select(scope), 평가대상: text(subject), 대상유형: select(type), 기간: text(period),
  업무성과: { type: 'number', number: s[0] }, 업무품질: { type: 'number', number: s[1] }, 생산성: { type: 'number', number: s[2] }, 전문성: { type: 'number', number: s[3] }, 협업태도: { type: 'number', number: s[4] },
  종합점수: { type: 'number', number: s[5] }, 총평: text(extra.review ?? '## 총평\n- 기한 준수'), 작성자: text(extra.author ?? '페퍼'), 주차별_업무내용: text(extra.work ?? ''), 주차별_성과: text(''),
}, extra.created ?? '2026-09-14T12:30:00.000Z');
export const reports = [
  rep('r-1', '홍길동 9월 2주 주간 평가', '주간', '홍길동', '대표', '2026-09-07 ~ 09-13', [80, 75, 90, 85, 70, 80], { work: '- 견적 3건' }),
  rep('r-2', '김직원 8월 월간 평가', '월간', '김직원', '직원', '2026년 8월', [70, 72, 68, 75, 88, 74.6], { created: '2026-09-01T00:10:00.000Z' }),
  rep('r-3', '루나 2025 연간 평가', '연간', '루나', '에이전트', '2025', [90, 85, 95, 80, 77, 85], { author: '효원' }),
];

const block = (type, value, children) => ({ object: 'block', id: `b-${Math.abs(JSON.stringify([type, value]).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}`, type, [type]: value, has_children: !!children?.length, ...(children ? { children } : {}) });
export const workboard = {
  id: 'w-root', title: '워크보드', blocks: [block('paragraph', { rich_text: rt('팀 노트 모음') })],
  children: [
    { id: 'w-1', title: '영업 플레이북', blocks: [
      block('heading_1', { rich_text: rt('첫 미팅') }),
      block('bulleted_list_item', { rich_text: rt('고객 문제부터 듣기') }, [block('bulleted_list_item', { rich_text: rt('예산은 마지막에') })]),
      block('bulleted_list_item', { rich_text: rt('견적은 24시간 안에', { bold: true }) }),
      block('to_do', { rich_text: rt('자료 준비'), checked: true }), block('to_do', { rich_text: rt('후속 메일'), checked: false }),
      block('callout', { rich_text: rt('가격표는 회사 정보 화면'), icon: { type: 'emoji', emoji: '💡' } }),
      block('paragraph', { rich_text: rt('참고', { link: 'https://example.test/guide' }) }),
      block('table', { table_width: 2, has_column_header: true }, [block('table_row', { cells: [rt('단계'), rt('기한')] }), block('table_row', { cells: [rt('견적'), rt('1일')] })]),
    ], children: [{ id: 'w-1-1', title: '반론 대응', blocks: [block('quote', { rich_text: rt('비싸다 → 범위부터 다시') }), block('divider', {}), block('code', { rich_text: rt('price = base * 1.1'), language: 'javascript' })], children: [] }] },
    { id: 'w-2', title: '회의록', blocks: [block('toggle', { rich_text: rt('9월 1주') }, [block('paragraph', { rich_text: rt('결정: 랜딩 개편') })]), block('image', { caption: rt('화이트보드'), type: 'file', file: { url: 'https://files.example.test/expiring.png' } }),
      // 16차: 2열과 토글 제목 — 오피스 2열·토글 블록으로 옮긴다
      block('column_list', {}, [block('column', {}, [block('paragraph', { rich_text: rt('잘된 점') })]), block('column', {}, [block('paragraph', { rich_text: rt('아쉬운 점') }), block('to_do', { rich_text: rt('다음 회의 안건'), checked: false })])]),
      block('heading_2', { rich_text: rt('9월 2주'), is_toggleable: true }, [block('paragraph', { rich_text: rt('결정: 가격표 개편') })]),
      block('bookmark', { caption: rt('회의 자료'), url: 'https://docs.example.test/deck' })], children: [] },
  ],
};

// 인트라넷 직원(board.db employees 표 — Notion 아님). cli_token은 옮기지 않는다(예시에도 넣지 않음)
export const employees = [{ id: 1, name: '홍길동', role: '대표', agent: 'claude' }, { id: 2, name: '김직원', role: '디자인', agent: 'codex' }, { id: 3, name: '이헤르', role: null, agent: 'hermes' }];
