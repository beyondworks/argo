// 산출물 클릭 다운로드 회귀 — 데스크톱 웹뷰(WKWebView/WebView2)는 a[download]가 무동작이라
// (실사용 제보 2026-08-07) Tauri IPC 저장 경로가 필요하다. 클라 컴포넌트·라우트는 next 의존으로
// node 테스트에서 임포트 불가 — 배선을 소스 앵커로 잠근다(runners-facade 앵커와 같은 집 관례).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const at = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

test('files 라우트: download=1이면 attachment(RFC 5987 filename*) + 오피스 MIME 등재', async () => {
  const src = await at('app/api/companies/[ws]/files/route.js');
  assert.ok(src.includes("searchParams.get('download') === '1'"), 'download 파라미터 분기');
  assert.ok(src.includes("filename*=UTF-8''"), '비ASCII(한글) 파일명 인코딩');
  assert.ok(src.includes('spreadsheetml.sheet'), 'xlsx MIME — 엑셀 산출물 제보의 직접 대상');
  // html은 절대 등재 금지 — text/html로 서빙하면 산출물이 앱 오리진 실행 페이지가 된다(검수 HIGH-1
  // 2026-08-07: 첨부 칩·[[링크]]는 download=1 없이 여는 경로 + CSP unsafe-inline + 텔레그램 .html 수신 경로).
  assert.ok(!/\bhtml:\s*'text\/html/.test(src), 'html MIME 등재 금지 — 같은 오리진 XSS 회귀');
  // 미리보기 경로 보호 — attachment는 파라미터 있을 때만(무조건 붙이면 썸네일·iframe이 다운로드로 변함)
  assert.ok(!/headers = \{[^}]*content-disposition/.test(src), '기본 응답엔 disposition 없음');
});

test('artifactDownload 헬퍼: 데스크톱만 가로채고 IPC save_download로 저장한다', async () => {
  const ui = await at('app/ui.jsx');
  const fn = ui.split('export function artifactDownload')[1]?.split('\n}')[0] ?? '';
  assert.ok(fn, '헬퍼 존재');
  assert.ok(fn.includes('isTauriApp()'), '데스크톱 감지 단일 출처 사용');
  assert.ok(fn.includes('preventDefault'), '앱에서 기본 앵커 차단');
  assert.ok(fn.includes("invoke('save_download'"), 'Rust 저장 커맨드 호출');
  assert.ok(fn.includes('revealItemInDir'), '저장 완료 피드백(파인더/탐색기 하이라이트)');
  // 실패·초과가 조용한 무동작이면 고치려던 증상과 화면이 같다(검수 MEDIUM) — 폴백 항해가 있어야 한다
  assert.ok(fn.includes('fallback()'), '실패 시 서버 다운로드 폴백');
  assert.ok(fn.includes('DOWNLOAD_IPC_CAP'), '대용량 IPC 상한 — 웹뷰 정지 방지');
});

test('배선: 채팅 칩·프리뷰·기억 페이지·설정 리포트 4곳이 헬퍼를 지난다', async () => {
  const crew = await at('app/c/[ws]/crew/[slug]/page.jsx');
  const vault = await at('app/c/[ws]/vault/page.jsx');
  const settings = await at('app/c/[ws]/settings/page.jsx');
  assert.equal((crew.match(/artifactDownload\(/g) ?? []).length, 2, '채팅: 칩 + 프리뷰 노트');
  assert.equal((vault.match(/artifactDownload\(/g) ?? []).length, 1, '기억(산출물) 파일 행');
  assert.equal((settings.match(/artifactDownload\(/g) ?? []).length, 1, '임포트 리포트 링크');
  // 브라우저 폴백 — 같은 앵커의 href가 서버 강제 다운로드(&download=1)도 함께 탄다
  for (const [name, src, n] of [['crew', crew, 2], ['vault', vault, 1], ['settings', settings, 1]]) {
    assert.ok((src.match(/&download=1/g) ?? []).length >= n, `${name}: href 브라우저 폴백`);
  }
});

test('Rust: save_download 커맨드 등록 + basename 강제(경로 조작 차단)', async () => {
  const rs = await at('src-tauri/src/lib.rs');
  assert.ok(rs.includes('fn save_download('), '커맨드 정의');
  assert.ok(rs.includes('generate_handler![save_download]'), 'invoke_handler 등록 — 빠지면 호출이 조용히 실패');
  assert.ok(rs.includes('.file_name()'), 'basename 강제');
  assert.ok(rs.includes('download_dir()'), 'OS 다운로드 폴더');
  // 이름 후보 소진 시 원본 덮어쓰기 금지(검수 MEDIUM) — 조용한 데이터 유실
  assert.ok(rs.includes('.ok_or_else('), '충돌 후보 소진은 에러로');
  const caps = await at('src-tauri/capabilities/default.json');
  assert.ok(caps.includes('opener:allow-reveal-item-in-dir'), 'reveal 권한 — 없으면 피드백이 조용히 죽는다');
});
