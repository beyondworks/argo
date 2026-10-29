// 동기화 원격 진단 꼬리(0.1.121, 2026-10-30 고객 C) — 메인 PC의 동기화가 첫 단계에서 멈췄는데 동기화 카드·진단 로그는 고객 화면에만 있어 우리가 못 봤다.
// 고객에게 로그·재로그인을 요구하지 않는다(유건 2026-10-29). 그래서 이미 30분마다 나가는 최소 버전 확인(argo_min_app_version, src/app-gate.mjs)의
// X-Client-Info 끝에 이 꼬리를 덧붙인다 — 요청 수는 그대로이고 edge_logs의 x_client_info에서 보인다(app-version.mjs 머리말: edge_logs가 남기는 머리글).
// 형식: `argo-sync/<단계>/<오류 종류>/l<잠금 주인 판|->/t<회수 이유|->/n<주인 없는 회사 수>/f<다른 계정 회사 수>/w<감시 재시작 수>/s<서비스 자격 무시 0|1>/c<귀속 실패 0|1>`.
// 계정 id·회사 id·토큰·경로·이메일은 싣지 않는다(개수·상태 코드·판 번호만). 글자는 [A-Za-z0-9._/-]만 — 서버 판정(' argo/' 위치·argo/<버전> 추출)과 겹치지 않는다.
// sync.mjs를 import하지 않는다(app-gate → devicesession → sync 순환) — 동기화 루프가 globalThis에 둔 상태만 읽는다(sync.mjs status·lockState와 같은 이름).
const clean = (v, max = 24) => String(v ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, max) || '-';

export function syncDiagTag(g = globalThis) {
  const st = g.__argoSyncStatus;
  const lock = g.__argoSyncLockState;
  if (!g.__argoSync || !st) return `argo-sync/${g.__argoSyncCredWatch ? 'not-started' : 'none'}`;
  const scanAt = Number(st.scanAt) || 0;
  const count = (kind) => Object.values(st.companies ?? {}).filter((c) => c?.skipped === kind && Number(c.ts) >= scanAt).length;
  const lockVer = lock?.elsewhere ? clean(lock.holder?.ver ?? 'x') : '-';
  return [
    'argo-sync',
    clean(st.phase ?? 'starting'),
    clean(st.errorCode),
    `l${lockVer}`,
    `t${clean(lock?.takeover?.reason)}`,
    `n${count('no-owner')}`,
    `f${count('foreign-owner')}`,
    `w${Number(st.watchdogRestarts) || 0}`,
    `s${st.svcIgnored ? 1 : 0}`,
    `c${st.claimError ? 1 : 0}`,
  ].join('/');
}

/** fetch 감싸기 — 나가는 X-Client-Info 끝에 진단 꼬리를 붙인다(이미 붙었으면 그대로). withArgoClientInfo 안쪽에 둔다(argo/<버전> 뒤에 붙도록). */
export function withSyncDiag(fetchImpl = (...a) => fetch(...a), tag = syncDiagTag) {
  return (input, init = {}) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const cur = headers.get('x-client-info');
    if (!cur?.includes(' argo-sync/')) headers.set('x-client-info', `${cur ?? ''} ${tag()}`.trim());
    return fetchImpl(input, { ...init, headers });
  };
}
