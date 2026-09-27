// 배달 지시 카드의 표시 문장 — 러너에게 보낸 프롬프트 원문 전체를 1:1 화면에 쏟지 않는다(제보 2026-09-27 "회의실 내용 구구절절").
// 회의실 발언은 프롬프트가 "지금 회의실에 있다…" 지시문 + 회의 대화 전체라 원문이 아니라 사장의 마지막 발언만 보인다.
export function viaSummary(via, text) {
  const s = String(text ?? '');
  if (via !== 'room') return s;
  const talk = s.split('## 회의 대화')[1]?.split('\n## ')[0] ?? '';
  const boss = talk.split('\n').filter((l) => l.startsWith('사장: ')).pop();
  return boss ? boss.slice(4) : s.split('\n').find((l) => l.trim()) ?? '';
}
