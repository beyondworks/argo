// 업무 > 자동화 목록에 보일 루틴 미러 행(순수). 목표 하트비트(Argo 본체 routines.json의 kind 'goal' — schedule.type 'goal')는 개인 기능이라
// 자동화 행으로 보이지 않는다. 새 본체는 목표를 미러하지 않지만(gateway/msgr-routines.mjs buildRoutineRows) 옛 본체(0.1.100 이하)는 올린다 —
// 화면에서 숨겨 메신저에서 고치거나 지우지 않게 한다(본체도 메신저 편집으로 목표를 바꾸지 않는다).
export const visibleRoutineRows = (rows) => (rows ?? []).filter((r) => r?.schedule?.type !== 'goal');
