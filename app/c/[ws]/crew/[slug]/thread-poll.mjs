// 크루 대화 폴링 반영 규칙 — JSX 없는 순수 함수(node --test가 직접 import해 검증한다).
// 두 폴(3초 준실시간·2.5초 진행 단계)이 **같은 반영 경로**를 쓴다(F2+, 2026-10-05): 진행 폴이 바뀐 본문을 받고도 버리고
// mtime만 앞으로 옮겨, 3초 폴이 unchanged를 받아 성공한 답이 화면에 영영 안 붙던 결함.

/** 화면에 보이는 뜻만 — 로컬 낙관 사본은 mid·ts가 서버 사본과 달라도 같은 글이다(바꿔 끼우면 핀·스크롤 기준이 사라진다). */
const view = (m) => [m?.who ?? null, m?.text ?? null, m?.failed ?? null, m?.failedCode ?? null, !!m?.aborted, m?.reply ?? null];
const sameView = (a, b) => a.length === b.length && a.every((m, i) => JSON.stringify(view(m)) === JSON.stringify(view(b[i])));

/** 폴링으로 받은 서버 스레드(msgs)를 지금 화면(cur)에 합친다.
    - 서버가 더 짧으면 그대로(옛 응답·되감기 — 화면을 줄이지 않는 종전 규칙).
    - 길이가 같아도 **뜻이 바뀌었으면** 서버 것을 쓴다(F2): 실패·중단 턴은 서버가 이미 저장된 지시 줄에 failed를 붙여 길이가 그대로다 —
      새로고침·다른 화면에서 돌아온 뒤 턴이 실패하면 실패 표시와 재전송 버튼이 안 뜨던 결함.
    - 서버 미보존 실패 사본(failed && unsaved)은 뒤에 이어 붙인다(서버엔 없는 글 — 복제 방지 규칙, 분리 검수 HIGH).
    - 뜻이 같으면 cur 참조를 그대로 돌려준다(리렌더·스크롤 기준 변화 0). */
export function mergePolledThread(cur, msgs) {
  if (cur == null || !Array.isArray(msgs)) return cur;
  const unsent = cur.filter((m) => m.failed && m.unsaved);
  const base = unsent.length ? cur.filter((m) => !(m.failed && m.unsaved)) : cur;
  if (msgs.length < base.length) return cur;
  if (msgs.length === base.length && sameView(base, msgs)) return cur;
  return unsent.length ? [...msgs, ...unsent] : msgs;
}

/** 폴 응답 하나를 어떻게 반영할지. 바뀐 본문은 반영한다(진행 폴도 — F2+).
    busy(내가 보낸 턴이 도는 중)면 낙관 사본을 덮지 않도록 본문을 반영하지 않는다. 이때 mtime은 옮기되(턴 내내 2.5초마다 전체 본문을
    다시 받지 않게 — 폴링 dedup의 이유, 2026-08-23) refetch를 세워, 턴이 끝난 뒤 첫 유휴 폴이 전체를 다시 받아 놓친 변경을 합친다. */
export function pollStep(r, { busy = false } = {}) {
  const status = r?.status ?? null;
  if (!r || r.unchanged) return { status, apply: false };
  if (busy) return { status, apply: false, mtime: r.mtime || null, refetch: true };
  return { status, apply: true, mtime: r.mtime || null, messages: r.messages ?? [] };
}

/** 폴 응답 반영기 — 두 폴(3초 준실시간·2.5초 진행)이 같은 것을 쓴다(F2+). 상태 변경은 주입한 setter로만 한다(화면 의존 없음).
    isBusy = 내가 보낸 턴이 도는 중인가(낙관 사본 보호). setStatus = 진행 카드 · setMtime/setRefetch = 폴링 dedup 표지 · mergeThread = 본문 병합 · onApplied = 본문을 반영한 뒤 부가 반영(세션·제목·위임 제한). */
export function makePollApplier({ isBusy, setStatus, setMtime, setRefetch, mergeThread, onApplied }) {
  return (r) => {
    const step = pollStep(r, { busy: isBusy() });
    setStatus(step.status); // 결재 후속·루틴·메신저발 턴도 진행 카드가 보인다
    if (step.refetch) setRefetch(true);
    if (step.mtime) setMtime(step.mtime);
    if (!step.apply) return;
    setRefetch(false);
    mergeThread(step.messages);
    onApplied?.(r);
  };
}

/** 폴 두 줄기를 한 번에 시작한다 — 반환 stop()은 타이머를 멈추고, **멈춘 뒤 도착한 응답은 버린다**(UL3: 크루를 바꾸기 직전에 나간 요청의 응답이
    새 방의 스레드·진행 카드·mtime에 섞이던 것). 방(ws·slug)이 바뀌면 호출부가 effect 정리에서 stop()을 부르고 새로 시작한다.
    idle(idleMs): 내 턴이 아닐 때만 — 다시 받기 표지(shouldRefetch)가 있으면 mtime 0(전체), 없으면 마지막 mtime(바뀐 것만).
    progress(progressMs): 무언가 도는 중(내 턴·결재 후속·루틴·메신저발)일 때만 — 마지막 mtime(없으면 1). 둘 다 같은 apply를 지난다. */
export function startThreadPolls({ fetchThread, apply, isBusy, isWorking, getMtime, shouldRefetch, idleMs = 3000, progressMs = 2500, timers = globalThis }) {
  let alive = true;
  const run = (mtime) => { fetchThread(mtime).then((r) => { if (alive) apply(r); }).catch(() => {}); };
  const idle = timers.setInterval(() => { if (isBusy()) return; run(shouldRefetch() ? 0 : getMtime()); }, idleMs);
  const progress = timers.setInterval(() => { if (!isWorking()) return; run(getMtime() || 1); }, progressMs);
  return () => { alive = false; timers.clearInterval(idle); timers.clearInterval(progress); };
}
