// 동기화 오류 표시 — src/sync.mjs가 남기는 내부 원문(한국어 고정·회사 id 접두)을 사용자 문구 키와 할 일로 바꾼다(F10·UX-A18, 2026-10-05).
// sync.mjs는 #832·#833이 막 바뀐 파일이라 문구 매핑은 화면 쪽에서 한다. 원문은 진단용으로 title에만 남긴다.
// 원문 형식(sync.mjs): syncFailedMessage `${ws}: 동기화 파일 N건 실패 (…) — 잠시 후 재시도` · '동기화 자격 없음/만료 — 재로그인 필요'
//   · '같은 데이터 루트를 다른 프로세스가 동기화 중 — …' · `${ws}: 계정 키 미확보 — 파일 N개 동기화 보류(…)` · `${ws}: <예외 원문>`

/** → { key, vars } (i18n 키 'settings.sync.err.*') 또는 null(오류 없음). */
export function syncErrorView(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^동기화 자격 없음\/만료/.test(s)) return { key: 'settings.sync.err.auth', vars: {} };
  if (/다른 프로세스가 동기화 중/.test(s)) return { key: 'settings.sync.err.otherProcess', vars: {} };
  const body = s.replace(/^[a-z0-9][a-z0-9-]{0,127}: /, ''); // 회사 id 접두 — 사용자에게는 의미 없는 값
  let m = body.match(/^동기화 파일 (\d+)건 실패/);
  if (m) return { key: 'settings.sync.err.files', vars: { n: Number(m[1]) } };
  m = body.match(/^계정 키 미확보 — 파일 (\d+)개/);
  if (m) return { key: 'settings.sync.err.accountKey', vars: { n: Number(m[1]) } };
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|timed? ?out|socket/i.test(body)) return { key: 'settings.sync.err.network', vars: {} };
  return { key: 'settings.sync.err.generic', vars: {} };
}
