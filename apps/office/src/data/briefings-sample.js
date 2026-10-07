// 브리핑 예시 데이터(서버 설정이 없는 예시 모드) — core/briefings.js가 처음 필요할 때 불러온다
const day = (n, h) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 11) + `${String(h).padStart(2, '0')}:00:00.000Z`;
export const SAMPLE_BRIEFINGS = [
  { id: 's1', org_name: 'Lean-AX', org_wide: false, kind: 'daily', period: '', title: '오전 브리프', author_kind: 'agent', author_name: '페퍼', created_at: day(0, 0),
    body: '## 오늘 챙길 것\n- [ ] 견적 2건 회신\n- [ ] 계약서 서명 확인\n\n## 어제 한 일\n- 거래처 미팅 정리\n\n> 입금 지연 1건이 있습니다.' },
  { id: 's2', org_name: 'Lean-AX', org_wide: true, kind: 'weekly', period: '이번 주', title: '조직 주간 현황', author_kind: 'agent', author_name: '페퍼', created_at: day(2, 3),
    body: '| 항목 | 건수 |\n|---|---|\n| 새 거래 | 3 |\n| 끝낸 할 일 | 12 |' },
  { id: 's3', org_name: null, org_wide: false, kind: 'custom', period: '', title: '개인 메모 정리', author_kind: 'person', author_name: '', created_at: day(5, 15), body: '지난주 메모를 정리했습니다.' },
];
