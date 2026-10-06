// '실행기 연결' 시트(유건 지시 2026-10-02, 아르고 패밀리 구조) — 에이전트가 일하려면 실행기(argo 엔진)가 하나 필요하다.
// 데스크톱 Argo 앱은 같은 엔진에 GUI를 얹은 것이라 "앱을 받으면 실행기가 함께 설치된다". 서버는 install.sh(docs/selfhost.md, 리눅스 x64).
export const RUNNER_INSTALL = 'curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash';

/** 시트 선택지 — 외부 에이전트(헤르메스·오픈클로) 연결은 조직 안에서만 되므로 조직이 없으면 뺀다. iOS는 앱 받기 링크를 두지 않는다(App Store 3.1.1, 총괄 2026-09-26) */
export function runnerOptions({ hasOrg = false, ios = false } = {}) {
  return [{ key: 'computer', download: !ios }, { key: 'server' }, ...(hasOrg ? [{ key: 'external' }] : [])];
}
