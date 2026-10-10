// 작업 과정 보이기 — 1:1 대화·회의실의 생각·도구·실행 단계(src/turn-trace.mjs, app/c/[ws]/turn-trace.jsx와 맞춘다).
export default {
  id: 'trace',
  ko: {
    title: '작업 과정 — 에이전트가 무엇을 하고 있는지 보기',
    keywords: ['작업 과정', '생각', '도구', '실행 단계', '단계 보기', '무엇을 하는지', '진행 상황', '입력 전체 보기'],
    body: `에이전트가 답하는 동안 생각·도구 호출·실행 중인 작업이 단계 목록으로 차례로 쌓여 보입니다. 1:1 대화와 회의실에서 보입니다.

- 진행 중에는 최근 8단계가 펼쳐져 있고, 앞쪽은 "앞 N단계 보기"로 엽니다.
- 답이 끝나면 답 아래에 "작업 과정 · N단계 · 걸린 시간"이 접힌 한 줄로 남습니다. 누르면 전체 단계를 펼칩니다.
- 단계를 누르면 입력과 결과가 보입니다. 결과는 앞 20줄을 먼저 보이고 "N줄 더 보기"로 나머지를 엽니다. 긴 입력은 "입력 전체 보기"로 엽니다.
- 실패하거나 멈춘 턴에는 "실패"·"중단됨" 표시가 붙어, 어디서 멈췄는지 볼 수 있습니다.
- 끝난 뒤에도 남는 것은 1:1 대화와 회의실 턴입니다. 루틴·메신저에서 처리한 턴은 진행 중에만 보이고 남기지 않습니다.
- 기록은 이 기기에만 저장하고 동기화하지 않습니다. 다른 기기에서 처리한 답에는 작업 과정이 없고 답만 보입니다.
- 보관 기준: 턴당 200KB, 에이전트마다 최근 100턴, 30일. 넘으면 "저장 한도로 남기지 않았어요"처럼 알려 줍니다.
- 입력·결과·생각에 들어 있는 키·토큰 같은 비밀값은 저장하기 전에 가립니다.`,
  },
  en: {
    title: 'Work process — seeing what an agent is doing',
    keywords: ['work process', 'thinking', 'tools', 'steps', 'what it is doing', 'progress', 'show full input'],
    body: `While an agent answers, its thinking, tool calls and running tasks appear as a list of steps. You see this in 1:1 chats and the Meeting Room.

- While it runs, the latest 8 steps are open; earlier ones open with "Show N earlier steps".
- When the answer is done, a folded line "Work process · N steps · duration" stays under the answer. Click it to open every step.
- Click a step to see its input and result. Results show the first 20 lines, with "Show N more lines" for the rest. Long inputs open with "Show full input".
- Failed or stopped turns are marked "Failed" or "Stopped", so you can see where they ended.
- Only 1:1 chat and Meeting Room turns are kept afterwards. Turns handled by routines or Messenger are visible only while running.
- The record is stored on this device only and is not synced. Answers handled on another device show the answer without a work process.
- Retention: 200KB per turn, the latest 100 turns per agent, 30 days. When a limit is hit, the view says so.
- Secrets such as keys and tokens in inputs, results and thinking are masked before saving.`,
  },
};
