// 메신저 기록 옮기기 표시 규칙 — JSX 없는 순수 함수(설정 카드·회사 화면 완료 안내가 같은 판정을 쓴다, 0.1.113).
// st = GET /api/companies/[ws]/msgr-archive 응답 { signedIn, paused, status, ws, dir, totals, failed, finishedAt, error } 또는 null(로드 전).
// status: none(기록 없음) · running(받는 중) · interrupted(앱이 꺼져 끊김 — 다음 시작 때 이어 받는다) · done · partial(첨부 일부 실패) · failed(서버 오류)

/** 설정 카드의 이관 영역. show = 보일까(스위치가 꺼져 있고 기록도 없으면 숨긴다), retry = 다시 받기 단추, polling = 진행 중 2초 로컬 조회. */
export function archiveView(st) {
  if (!st?.signedIn) return { show: false, phase: 'none', retry: false, polling: false };
  const phase = st.status ?? 'none';
  if (phase === 'none' && !st.paused) return { show: false, phase, retry: false, polling: false };
  const tot = st.totals ?? {};
  return {
    show: true, phase,
    progress: { done: tot.roomsDone ?? 0, total: tot.rooms ?? 0, messages: tot.messages ?? 0, attachments: tot.attachments ?? 0, failed: st.failed ?? 0 },
    // 다시 받기 — 스위치가 켜져 있을 때만(서버 POST도 같은 조건). 끝난 계정은 단추가 없다(같은 것을 두 번 받지 않는다)
    retry: !!st.paused && ['none', 'failed', 'partial', 'interrupted'].includes(phase),
    polling: phase === 'running',
  };
}

/** 진행 문구 키 — phase마다 하나. */
export function archiveLabelKey(phase) {
  return {
    none: 'settings.msgrArchive.none', running: 'settings.msgrArchive.running', interrupted: 'settings.msgrArchive.interrupted',
    done: 'settings.msgrArchive.done', partial: 'settings.msgrArchive.partial', failed: 'settings.msgrArchive.failed',
  }[phase] ?? 'settings.msgrArchive.none';
}

/** 회사 화면 머리의 완료 안내를 보일까 — 끝났고(done·partial), 이 기기에서 같은 완료를 닫은 적이 없을 때. seen = localStorage에 둔 닫은 완료 키. */
export function archiveNoticeKey(st) {
  if (!st?.signedIn || !st.dir || !(st.status === 'done' || st.status === 'partial')) return null;
  return `${st.dir}|${st.finishedAt ?? ''}`;
}
export function showArchiveNotice(st, seen) {
  const key = archiveNoticeKey(st);
  return !!key && key !== seen;
}
export const ARCHIVE_NOTICE_SEEN = 'argo-msgr-archive-notice';

/** 메신저 일시 중단 동안 출시 알림 카드 아래 한 줄('옮겨진 메신저 기록 · 폴더 열기') — 받은 기록(done·partial)이 있을 때만. 진행률·지금 옮기기·다시 받기는 두지 않는다
    (partial은 앱 시작 때 자동으로 다시 받는다). st = 이관 GET 응답. → { dir } | null */
export function waitlistArchiveLine(st) {
  if (!st?.signedIn || !st.dir || !(st.status === 'done' || st.status === 'partial')) return null;
  return { dir: st.dir };
}
