// 기본 템플릿(유건 2026-09-27: 7종 + 인트라넷 기능 참조 — 드라이브·캘린더·거래처·문서함·전자서명·도구함).
// 인트라넷 항목은 ~/lean-projects/AI-Native 화면·표의 필드를 옮겼다(표 블록이 없어 "항목: 값" 목록·할 일 목록으로).
// 문자열은 [ko, en] — 사전(i18n)과 같은 규칙. 템플릿을 고를 때만 불러온다(첫 화면 무게 밖).
const L = (lang) => (pair) => pair[lang === 'en' ? 1 : 0];

const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
const ul = (items) => ({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [p(x)] })) });
const todo = (items) => ({ type: 'taskList', content: items.map((x) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(x)] })) });

/** 섹션 = [제목, 종류, 항목들] — 종류: ul(항목: 값 목록) | todo(체크리스트) | p(빈 문단) */
const T = [
  { id: 'meeting', group: 'basic', title: ['회의록', 'Meeting notes'], sections: [
    [['참석자', 'Attendees'], 'ul', [['', '']]],
    [['안건', 'Agenda'], 'ul', [['', '']]],
    [['논의 내용', 'Discussion'], 'p'],
    [['결정 사항', 'Decisions'], 'ul', [['', '']]],
    [['할 일', 'Action items'], 'todo', [['담당자 · 할 일 · 기한', 'Owner · task · due']]],
  ] },
  { id: 'weekly', group: 'basic', title: ['주간 보고', 'Weekly report'], sections: [
    [['이번 주 한 일', 'Done this week'], 'ul', [['', '']]],
    [['다음 주 할 일', 'Next week'], 'todo', [['', '']]],
    [['막힌 것', 'Blockers'], 'ul', [['', '']]],
    [['지표', 'Numbers'], 'ul', [['지표: 값', 'Metric: value']]],
  ] },
  { id: 'project', group: 'basic', title: ['프로젝트 개요', 'Project brief'], sections: [
    [['목표', 'Goal'], 'p'],
    [['범위', 'Scope'], 'ul', [['포함: ', 'In: '], ['제외: ', 'Out: ']]],
    [['일정', 'Timeline'], 'ul', [['시작: ', 'Start: '], ['중간 점검: ', 'Checkpoint: '], ['마감: ', 'Due: ']]],
    [['담당', 'Owners'], 'ul', [['책임자: ', 'Lead: '], ['참여: ', 'Members: ']]],
    [['위험', 'Risks'], 'ul', [['', '']]],
  ] },
  { id: 'handover', group: 'basic', title: ['업무 인수인계', 'Handover'], sections: [
    [['현황', 'Current state'], 'p'],
    [['진행 중인 일', 'In progress'], 'todo', [['', '']]],
    [['연락처', 'Contacts'], 'ul', [['이름 · 역할 · 연락처', 'Name · role · contact']]],
    [['자료 위치', 'Where things are'], 'ul', [['', '']]],
    [['주의사항', 'Watch out for'], 'ul', [['', '']]],
  ] },
  { id: 'hiring', group: 'basic', title: ['채용 공고', 'Job posting'], sections: [
    [['회사 소개', 'About us'], 'p'],
    [['하는 일', 'What you will do'], 'ul', [['', '']]],
    [['자격 요건', 'Requirements'], 'ul', [['', '']]],
    [['우대 사항', 'Nice to have'], 'ul', [['', '']]],
    [['근무 조건', 'Terms'], 'ul', [['근무지: ', 'Location: '], ['고용 형태: ', 'Type: '], ['급여: ', 'Pay: ']]],
    [['지원 방법', 'How to apply'], 'p'],
  ] },
  { id: 'proposal', group: 'basic', title: ['제안서', 'Proposal'], sections: [
    [['배경', 'Background'], 'p'],
    [['문제', 'Problem'], 'p'],
    [['제안', 'Proposal'], 'ul', [['', '']]],
    [['일정과 비용', 'Timeline and cost'], 'ul', [['기간: ', 'Duration: '], ['비용: ', 'Cost: ']]],
    [['기대 효과', 'Expected outcome'], 'ul', [['', '']]],
  ] },
  { id: 'retro', group: 'basic', title: ['회고', 'Retrospective'], sections: [
    [['잘된 것', 'What went well'], 'ul', [['', '']]],
    [['아쉬운 것', 'What to improve'], 'ul', [['', '']]],
    [['배운 것', 'Lessons'], 'ul', [['', '']]],
    [['다음에 할 것', 'Next actions'], 'todo', [['', '']]],
  ] },
  // ── 인트라넷 기능 참조 ──
  { id: 'drive', group: 'intranet', title: ['파일 보관 대장', 'File register'], sections: [
    [['개요', 'Overview'], 'ul', [['보관 위치: 내 드라이브 / 공유 드라이브 / 공유 문서함', 'Location: My Drive / Shared drive / Shared with me'], ['폴더 경로: ', 'Folder path: ']]],
    [['폴더 구조', 'Folders'], 'ul', [['폴더명 · 상위 경로 · 용도', 'Folder · parent path · purpose']]],
    [['파일 목록', 'Files'], 'ul', [['이름 · 형식 · 소유자 · 크기 · 수정일 · 링크', 'Name · type · owner · size · modified · link']]],
    [['즐겨찾기', 'Favorites'], 'ul', [['이름 · 링크', 'Name · link']]],
    [['업로드 기록', 'Uploads'], 'ul', [['파일명 · 위치 · 결과(성공/실패)', 'File · location · result (ok/failed)']]],
  ] },
  { id: 'calendar', group: 'intranet', title: ['일정 기록', 'Event record'], sections: [
    [['기본 정보', 'Basics'], 'ul', [['날짜: ', 'Date: '], ['시간: ', 'Time: '], ['종료일: ', 'Ends: '], ['종일: 예 / 아니오', 'All day: yes / no']]],
    [['장소·분류', 'Place and category'], 'ul', [['장소: ', 'Location: '], ['카테고리: ', 'Category: '], ['우선순위: 높음 / 보통 / 낮음', 'Priority: high / medium / low']]],
    [['진행 상태', 'Status'], 'todo', [['시작 전', 'Not started'], ['진행 중', 'In progress'], ['보류', 'Pending'], ['완료', 'Completed']]],
    [['담당', 'Owner'], 'ul', [['담당: ', 'Owner: '], ['출처: ', 'Source: ']]],
    [['메모', 'Notes'], 'p'],
  ] },
  { id: 'client', group: 'intranet', title: ['거래처 카드', 'Client card'], sections: [
    [['기본 정보', 'Basics'], 'ul', [['회사명: ', 'Company: '], ['분류: 고객 / 협력사 / 공급사 / 기타', 'Type: customer / partner / supplier / other'], ['상태: 활성 / 보류 / 종료', 'Status: active / on hold / closed']]],
    [['담당·연락', 'Contact'], 'ul', [['담당자: ', 'Contact person: '], ['연락처: ', 'Phone: '], ['이메일: ', 'Email: '], ['주소: ', 'Address: '], ['계좌: ', 'Bank account: ']]],
    [['첨부 서류', 'Documents'], 'todo', [['사업자등록증', 'Business registration'], ['통장사본', 'Bank statement'], ['계약서', 'Contract']]],
    [['거래 내역', 'Deals'], 'ul', [['건명 · 합계 · 상태(견적/계약/계산서발행/입금완료/취소) · 견적일 · 계약일 · 계산서일 · 입금예정일 · 입금일', 'Deal · total · status (quote/contract/invoiced/paid/cancelled) · quote · contract · invoice · due · paid']]],
    [['관련 문서·진행 업무', 'Related docs and work'], 'ul', [['', '']]],
    [['메모', 'Notes'], 'p'],
  ] },
  { id: 'document', group: 'intranet', title: ['문서 보관 카드', 'Document card'], sections: [
    [['문서 정보', 'Document'], 'ul', [['제목: ', 'Title: '], ['파일명: ', 'File name: '], ['유형: PDF / 이미지 / 문서 / 기타', 'Type: PDF / image / doc / other'], ['크기: ', 'Size: '], ['등록일: ', 'Added: ']]],
    [['분류·연결', 'Category and links'], 'ul', [['분류: 견적서 / 계약서 / 사업자등록증 / 명함 / 증빙 / 보관 / 일반', 'Category: quote / contract / registration / business card / receipt / archive / general'], ['거래처: ', 'Client: '], ['태그: ', 'Tags: ']]],
    [['본문 요약', 'Summary'], 'p'],
    [['글자 인식(OCR)', 'Text recognition (OCR)'], 'todo', [['완료', 'Done'], ['대기', 'Waiting'], ['실패', 'Failed'], ['미지원', 'Not supported']]],
    [['원본 링크', 'Original'], 'p'],
  ] },
  { id: 'esign', group: 'intranet', title: ['전자서명 진행표', 'E-signature tracker'], sections: [
    [['계약 개요', 'Contract'], 'ul', [['제목: ', 'Title: '], ['작성자: ', 'Owner: '], ['생성일: ', 'Created: '], ['상태: 초안 / 서명 대기 / 완료 / 취소됨', 'Status: draft / sent / completed / cancelled']]],
    [['서명자', 'Signers'], 'ul', [['순번 · 이름/회사 · 이메일 · 상태(대기/서명) · 서명일시', 'Order · name/company · email · status (pending/signed) · signed at']]],
    [['서명 필드', 'Fields'], 'ul', [['서명자 · 종류(서명/텍스트/날짜) · 페이지 · 필수 여부', 'Signer · kind (signature/text/date) · page · required']]],
    [['진행', 'Progress'], 'todo', [['초안', 'Draft'], ['발송', 'Sent'], ['열람', 'Opened'], ['서명', 'Signed'], ['완료', 'Completed']]],
    [['감사 기록', 'Audit trail'], 'ul', [['시각 · 행위자 · 행동 · IP', 'Time · actor · action · IP']]],
    [['완료본 링크', 'Signed copy'], 'p'],
  ] },
  { id: 'tool', group: 'intranet', title: ['도구 등록 카드', 'Tool card'], sections: [
    [['기본 정보', 'Basics'], 'ul', [['이름: ', 'Name: '], ['종류: 스킬 / MCP / 플러그인', 'Kind: skill / MCP / plugin'], ['호출 명령어: ', 'Command: ']]],
    [['상태', 'Status'], 'todo', [['활성화', 'Enabled'], ['공유됨', 'Shared']]],
    [['사용 환경', 'Where it runs'], 'ul', [['쓰는 도구: 클로드 코드 / 코덱스 / 헤르메스', 'Used by: Claude Code / Codex / Hermes'], ['전송 방식: stdio / http', 'Transport: stdio / http']]],
    [['설명', 'Description'], 'p'],
    [['위치', 'Location'], 'ul', [['로컬 경로 또는 마켓플레이스: ', 'Local path or marketplace: ']]],
  ] },
];

export const BUILTINS = T.map(({ id, group, title }) => ({ id, group, title }));

/** 기본 템플릿 → { title, content }(편집기 문서) */
export function builtin(id, lang) {
  const t = T.find((x) => x.id === id);
  if (!t) return null;
  const s = L(lang), title = s(t.title);
  const body = t.sections.flatMap(([name, kind, items]) => [h(2, s(name)), kind === 'ul' ? ul(items.map(s)) : kind === 'todo' ? todo(items.map(s)) : p('')]);
  return { title, content: { type: 'doc', content: [h(1, title), ...body] } };
}
