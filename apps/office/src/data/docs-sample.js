// 공용 문서 예시(16차) — 예시 데이터 모드(5400)의 공용 문서 화면에서만 쓴다. 공용 문서 화면과 함께 지연 로드된다(첫 화면 밖).
// 모양은 기록판 문서(core/board.js mapBoard의 docs)와 같다. 본문은 열 때 읽는 것과 같게 따로 둔다.
const at = (d) => new Date(Date.now() - d * 864e5).toISOString();
export const SAMPLE_DOCS = [
  { id: 'doc-rules-voice', space: 'beyondworks', folder: 'rules', title: '고객 응대 말투', path: 'rules/voice.md', updated: at(2), channel: '' },
  { id: 'doc-rules-approval', space: 'beyondworks', folder: 'rules', title: '결재가 필요한 일', path: 'rules/approval.md', updated: at(6), channel: '' },
  { id: 'doc-glossary-deal', space: 'beyondworks', folder: 'glossary', title: '거래 단계 용어', path: 'glossary/deal.md', updated: at(9), channel: '' },
  { id: 'doc-projects-landing', space: 'beyondworks', folder: 'projects', title: '랜딩 개편', path: 'projects/landing.md', updated: at(1), channel: '마케팅' },
  { id: 'doc-projects-office', space: 'beyondworks', folder: 'projects', title: '오피스 이관 계획', path: 'projects/office-migrate.md', updated: at(0.2), channel: '개발' },
];
export const SAMPLE_DOC_BODIES = {
  'doc-rules-voice': '---\ntitle: 고객 응대 말투\n---\n# 고객 응대 말투\n\n- **존댓말**로 씁니다\n- 답을 먼저, 이유는 뒤에\n- 모르면 모른다고 하고 언제까지 알려 드릴지 적습니다\n\n> 사과는 한 번, 해결책은 구체적으로\n',
  'doc-rules-approval': '# 결재가 필요한 일\n\n1. 외부로 나가는 메일\n2. 10만 원 넘는 결제\n3. 고객 데이터 내보내기\n\n---\n\n결재 요청은 [결재함 안내](https://example.com/approval)를 따릅니다.\n',
  'doc-glossary-deal': '# 거래 단계 용어\n\n| 단계 | 뜻 |\n| --- | --- |\n| 견적 | 금액을 처음 보낸 상태 |\n| 계약 | 서명까지 끝난 상태 |\n| 청구 | 계산서를 보낸 상태 |\n',
  'doc-projects-landing': '# 랜딩 개편\n\n## 할 일\n\n- [x] 첫 화면 문구 정하기\n- [ ] 가격표 다시 그리기\n  - [ ] 월간·연간 나란히\n- [ ] 후기 세 개 받기\n\n```\n배포: 금요일 오후\n```\n',
  'doc-projects-office': '# 오피스 이관 계획\n\n인트라넷 기능을 오피스로 옮깁니다. 순서는 *할 일 → 거래 → 페이지*입니다.\n\n- 노션 페이지는 한 번만 옮기고 오피스가 원본이 됩니다\n- 옮긴 뒤 ~~노션 동기화~~는 하지 않습니다\n',
};
