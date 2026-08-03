// 크루 우측 사이드 패널 회귀 게이트 — Codex식 토글과 파일/터미널/브라우저 도구 작업영역,
// 업데이트 후 재적용 패치가 의존하는 안정 표식을 함께 지킨다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const crew = read('app/c/[ws]/crew/[slug]/page.jsx');
const panel = read('app/c/[ws]/crew/[slug]/workspace-panel.jsx');
const shell = read('app/c/[ws]/layout.jsx');
const css = read('app/globals.css');
const ui = read('app/ui.jsx');
const i18n = read('app/i18n.jsx');
const nextConfig = read('next.config.mjs');
const tauri = read('src-tauri/tauri.conf.json');
const workspaceRoute = read('app/api/companies/[ws]/workspace/route.js');
const terminalRoute = read('app/api/companies/[ws]/terminal/route.js');

test('사이드 패널 토글: 탑바 우측 슬롯 + 눌림/제어 대상 접근성 계약', () => {
  assert.match(shell, /id="argo-topbar-panel-slot"/, '앱셸 우측 토글 슬롯이 없다');
  assert.match(crew, /aria-controls="crew-side-panel"/, '토글이 제어할 패널을 가리키지 않는다');
  assert.match(crew, /aria-pressed=\{panelOpen\}/, '열림 상태가 눌림 상태로 노출되지 않는다');
  assert.match(crew, /<WorkspacePanel ws=\{ws\}/, '토글이 도구 작업영역을 열지 않는다');
  assert.match(panel, /id="crew-side-panel"/, '패널 id가 토글 계약과 어긋난다');
  assert.match(panel, /role="tablist"/);
  assert.match(panel, /role="tabpanel"/);
});

test('회사 전역 화면: 검색창 옆 토글과 고정 작업영역을 제공한다', () => {
  assert.match(shell, /isCrewPage = pathname\.includes\('\/crew\/'\)/);
  assert.match(shell, /!isCrewPage && \(\s*<button[\s\S]*side-panel-toggle/);
  assert.match(shell, /aria-controls="crew-side-panel"/);
  assert.match(shell, /<GlobalWorkspacePanel[\s\S]*fileRequest=\{panelFileRequest\}/);
  assert.match(shell, /argo:workspace-file/);
  assert.match(css, /\.global-workspace-panel\s*\{[\s\S]*position: fixed/);
  assert.match(css, /\.global-workspace-panel > \.crew-tool-panel/);
});

test('사이드 패널 상태: Ctrl+Alt+B + 새로고침 후 열림/도구 탭 복원', () => {
  assert.match(crew, /PANEL_STORAGE_KEY = 'argo:crew-side-panel:v1'/);
  assert.match(crew, /localStorage\.getItem\(PANEL_STORAGE_KEY\)/);
  assert.match(crew, /localStorage\.setItem\(PANEL_STORAGE_KEY/);
  assert.match(crew, /e\.code !== 'KeyB'/, '키보드 배열에 안전한 code 기반 단축키가 아니다');
  assert.match(crew, /\(e\.ctrlKey \|\| e\.metaKey\).*e\.altKey/, 'Ctrl 또는 Cmd + Alt 조합이 아니다');
  assert.match(panel, /TOOL_STORAGE_KEY = 'argo:crew-side-panel-tools:v1'/);
  assert.match(panel, /JSON\.stringify\(\{ tabs, active, panelWidth \}\)/, '열린 도구 탭과 패널 폭이 복원되지 않는다');
  assert.match(panel, /FILE_TREE_STORAGE_KEY/, '파일 트리 폭 저장 키가 없다');
  assert.match(crew, /const \[panelMounted, setPanelMounted\] = useState\(false\)/);
  assert.match(crew, /\(panelOpen \|\| panelMounted\).*?<WorkspacePanel ws=\{ws\} open=\{panelOpen\}/s,
    '패널을 숨길 때 Markdown 초안과 도구 상태를 보존하지 않는다');
  assert.match(panel, /hidden=\{!open\}/);
  assert.match(panel, /tabs\.includes\('files'\).*?hidden=\{active !== 'files'\}/s,
    '도구 탭을 전환할 때 파일 편집기를 마운트 해제한다');
  assert.match(css, /\.crew-tool-panel\[hidden\], \.crew-tool-view\[hidden\] \{ display: none; \}/);
});

test('도구 작업영역: 파일 열기·지속 터미널·내장 브라우저를 새 탭 메뉴에서 연다', () => {
  assert.match(panel, /TOOL_ORDER = \['files', 'terminal', 'browser'\]/);
  assert.match(panel, /className="crew-tool-launcher"/);
  assert.match(panel, /function FileTool\(/);
  assert.match(panel, /action: 'list'/);
  assert.match(panel, /action: 'open'/);
  assert.match(panel, /function TerminalTool\(/);
  assert.match(panel, /action: 'start'/);
  assert.match(panel, /action: 'input'/);
  assert.match(panel, /function BrowserTool\(/);
  assert.match(panel, /<iframe[\s\S]*sandbox=/);
});

test('도구 API: 회사 가드·로컬 전용 셸·경로 관문을 통과한다', () => {
  assert.match(workspaceRoute, /guardCompany\(ws\)/);
  assert.match(workspaceRoute, /csrfDenied\(req\)/);
  assert.match(workspaceRoute, /listWorkspaceDirectory/);
  assert.match(workspaceRoute, /readWorkspaceToolRaw/);
  assert.match(workspaceRoute, /saveWorkspaceToolMarkdown/);
  assert.match(workspaceRoute, /export async function PUT/);
  assert.match(workspaceRoute, /file\.inline \? file\.type : 'application\/octet-stream'/);
  assert.match(workspaceRoute, /file\.inline \? 'inline' : 'attachment'/);
  assert.match(terminalRoute, /isLoopbackHost/);
  assert.match(terminalRoute, /csrfDenied/);
  assert.match(terminalRoute, /loadCapabilities/);
  assert.match(terminalRoute, /resolveWorkspaceToolRoot/);
});

test('사이드 패널 레이아웃: 우측 트리·여백 제거 + 넓은 화면 도킹/좁은 화면 오버레이', () => {
  assert.match(crew, /crew-workspace.*has-side-panel/s);
  assert.match(css, /\.crew-workspace\.has-side-panel\s*\{[^}]*minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.content:has\(> \.crew-workspace\.has-side-panel\)\s*\{[^}]*max-width: none;[^}]*padding-right: 0;/s);
  assert.match(css, /@media \(max-width: 1699px\)[\s\S]*\.crew-workspace > \.crew-tool-panel\s*\{[\s\S]*position: fixed/);
  assert.match(css, /\.crew-files-tool[^}]*grid-template-columns: minmax\(0, 1fr\) 6px var\(--crew-file-tree-width, 220px\)/);
  assert.match(css, /\.crew-files-sidebar\s*\{[^}]*grid-column: 3/s, '파일 트리가 오른쪽 열이 아니다');
  assert.match(css, /\.crew-file-document\s*\{[^}]*grid-column: 1/s, '열린 파일 문서가 왼쪽 열이 아니다');
  assert.match(css, /\.side-panel-toggle\.active/);
});

test('파일 열기: 열린 탭을 유지하고 Markdown 편집·저장과 샌드박스 HTML 문서를 제공한다', () => {
  assert.match(panel, /const \[openFiles, setOpenFiles\] = useState\(\[\]\)/);
  assert.match(panel, /className="crew-file-open-tabs" role="tablist"/);
  assert.match(panel, /setOpenFiles\(\(current\).*?\[\.\.\.current, file\]/s);
  assert.match(panel, /<Markdown text=\{markdownText\}/, 'Markdown 미리보기가 현재 편집 초안을 렌더링하지 않는다');
  assert.match(panel, /method: 'PUT'/, 'Markdown 저장 요청이 없다');
  assert.match(panel, /className="crew-file-markdown-editor"/, 'Markdown 편집기가 없다');
  assert.match(panel, /aria-keyshortcuts="Control\+S Meta\+S"/, '저장 단축키가 없다');
  assert.match(panel, /beforeunload/, '저장하지 않은 편집의 이탈 경고가 없다');
  assert.match(panel, /onDirtyChange=\{setFilesDirty\}/, '파일 탭을 닫을 때 미저장 초안을 감지하지 않는다');
  assert.match(panel, /tool === 'files' && filesDirty.*?discardConfirm/,
    '미저장 Markdown이 있는데 파일 도구 탭을 닫을 수 있다');
  assert.match(panel, /file-changed/, '외부 변경 충돌 안내가 없다');
  assert.match(
    panel,
    /srcDoc=\{activeDocument\.data\.content\} sandbox="allow-scripts" referrerPolicy="no-referrer"/,
    '열린 HTML은 동적 문서 스크립트만 허용하는 출처 격리 샌드박스여야 한다',
  );
  assert.doesNotMatch(
    panel.match(/srcDoc=\{activeDocument\.data\.content\}[^>]+/)?.[0] || '',
    /allow-same-origin/,
    '열린 HTML이 Argo 출처 권한을 가져서는 안 된다',
  );
  assert.match(css, /\.crew-file-markdown[\s\S]*\.crew-file-html/);
  assert.match(css, /\.crew-file-markdown-editor/);
  assert.match(workspaceRoute, /action === 'open'/);
  assert.match(workspaceRoute, /action === 'render'/, 'Office 문서 PDF 렌더 라우트가 없다');
  assert.match(panel, /activeDocument\.data\?\.kind === 'office'/, 'Office 문서 미리보기가 없다');
  assert.match(panel, /action: 'render'/, 'Office 문서가 원본 다운로드가 아닌 렌더 URL을 사용해야 한다');
});

test('채팅 문서 링크: 새 404 페이지 대신 파일 패널을 열고 트리를 해당 경로까지 확장한다', () => {
  assert.match(ui, /onFileLink/);
  assert.match(ui, /data-argo-file-link/);
  assert.match(crew, /openWorkspaceFile/);
  assert.match(crew, /url\.pathname === `\/c\/\$\{ws\}\/vault`/);
  assert.match(crew, /url\.pathname === `\/api\/companies\/\$\{ws\}\/files`/);
  assert.match(crew, /path = `vault\/\$\{path\}`/,
    'Vault 기준 rel을 회사 루트 기준 경로로 변환하지 않는다');
  assert.match(crew, /const vaultMarker = path\.indexOf\('\/vault\/'\)/,
    '절대 workspace 파일 경로에서 vault 경계 뒤를 추출하지 않는다');
  assert.match(crew, /setPanelOpen\(true\)/);
  assert.match(crew, /fileRequest=\{panelFileRequest\}/);
  assert.match(panel, /setActive\('files'\)/);
  assert.match(panel, /const ancestors = \['', \.\.\.parts\.slice\(0, -1\)/);
  assert.match(panel, /Promise\.all\(ancestors\.map\(\(dir\) => loadDir\(dir\)\)\)/);
  assert.match(panel, /openFile\(path\)/);
});

test('사이드 패널 리사이즈: 바깥 패널과 내부 파일 트리에 포인터·키보드 분할선 제공', () => {
  assert.match(panel, /className="crew-tool-panel-resizer" role="separator" tabIndex=\{0\}/);
  assert.match(panel, /className="crew-file-splitter" role="separator" tabIndex=\{0\}/);
  assert.equal((panel.match(/aria-orientation="vertical"/g) || []).length, 2);
  assert.match(panel, /setPointerCapture/);
  assert.match(panel, /onPointerMove/);
  assert.match(panel, /event\.key === 'ArrowLeft'/);
  assert.match(css, /\.crew-tool-panel-resizer[^}]*cursor: col-resize/s);
  assert.match(css, /\.crew-file-splitter[^}]*cursor: col-resize/s);
});

test('내장 브라우저 CSP: http(s) 프레임을 허용하되 Argo 자체는 same-origin만 허용', () => {
  assert.match(nextConfig, /"frame-src http: https:"/);
  assert.match(nextConfig, /"frame-ancestors 'self'"/);
  assert.match(nextConfig, /X-Frame-Options'?, value: 'SAMEORIGIN'/);
  assert.match(tauri, /frame-src http: https:/);
  assert.match(tauri, /frame-ancestors 'self'/);
});

test('사이드 패널 UI: 공용 아이콘과 한영 라벨을 사전에서 제공', () => {
  for (const icon of ['panel', 'folder', 'terminal', 'browser', 'download', 'external']) {
    assert.match(ui, new RegExp(`\\b${icon}:\\s*'M`), `${icon} 아이콘이 없다`);
  }
  assert.match(i18n, /'crew\.panel\.toggle': \['사이드 패널 표시\/숨기기', 'Toggle side panel'\]/);
  assert.match(i18n, /'crew\.tools\.files': \['파일', 'Files'\]/);
  assert.match(i18n, /'crew\.tools\.files\.openFiles': \['열린 파일', 'Open files'\]/);
  assert.match(i18n, /'crew\.tools\.files\.pick': \['파일을 선택해서 여세요', 'Select a file to open it'\]/);
  assert.match(i18n, /'crew\.tools\.files\.editor': \['Markdown 편집기', 'Markdown editor'\]/);
  assert.match(i18n, /'crew\.tools\.files\.changed': \['파일이 외부에서 변경되었습니다\./);
  assert.match(i18n, /'crew\.tools\.terminal': \['터미널', 'Terminal'\]/);
  assert.match(i18n, /'crew\.tools\.browser': \['브라우저', 'Browser'\]/);
  assert.match(i18n, /'crew\.tools\.resizePanel': \['사이드 패널 폭 조절', 'Resize side panel'\]/);
  assert.match(i18n, /'crew\.tools\.files\.resize': \['파일 트리 폭 조절', 'Resize file tree'\]/);
});
