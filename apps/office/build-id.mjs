// 빌드마다 다른 표시 — 앱 안(__OFFICE_BUILD__)과 dist/version.json에 같은 값을 넣는다. 열어 둔 탭이 새 배포를 알아채는 데 쓴다(src/core/version-check.js, 유건 10/4).
// vite.config.js가 부른다(설정 파일은 .env를 읽어서 시험은 이 파일만 불러온다 — test/version-check.test.mjs).
export function buildId(id = Date.now().toString(36)) {
  return {
    name: 'office-build-id',
    config: () => ({ define: { __OFFICE_BUILD__: JSON.stringify(id) } }),
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id }) }); },
  };
}
