// 신규 기기 스모크 — "개발 PC 실측은 신규 기기 실패를 못 잡는다"(유건 지적 2026-07-22)의 기계화.
// CI의 macOS 러너 = claude CLI 미설치·빈 키체인·헤드리스(브라우저 없음) — 신규 맥과 등가 조건이다.
// 검증 계약(원클릭 setup-token 대행):
//   ① 번들 SDK CLI가 해석된다(신규 기기의 유일한 실행기 — resolveClaudeCli 폴백)
//   ② PTY 대행이 즉사하지 않고 인증 URL을 관측한다(authUrl — 브라우저가 안 열리는 기기의 폴백 링크)
//   ③ 신형 CLI 코드 프롬프트(awaitCode)까지 도달한다(코드 왕복 UI가 열리는 조건)
// 승인은 하지 않는다 — OAuth authorize URL 생성(로컬 PKCE)까지만이라 계정 부작용이 없다.
// 사용: node scripts/smoke-fresh-device.mjs   (실패 시 exit 1 — CI가 릴리즈를 막는다)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-smoke-'));
process.env.ARGO_STANDALONE = '1'; // 원클릭 게이트 통과(데스크톱 번들 조건)
delete process.env.ARGO_TENANT_OWNER;

const { startClaudeSetupToken, setupTokenStatus, bundledClaudeCli } = await import('../src/runners.mjs');

const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); process.exit(1); };

if (process.platform === 'win32') { console.log('SMOKE SKIP: win32(script(1) 부재 — 원클릭 미지원 플랫폼)'); process.exit(0); }

// ① 번들 CLI — 신규 기기에서 원클릭이 기대는 유일한 실행기
const bundled = await bundledClaudeCli();
const hasCliOverride = !!process.env.CLAUDE_CLI;
console.log(`bundled CLI: ${bundled ?? '(없음)'}${hasCliOverride ? ` (CLAUDE_CLI 오버라이드: ${process.env.CLAUDE_CLI})` : ''}`);
if (!bundled && !hasCliOverride) fail('번들 SDK CLI가 해석되지 않음 — 신규 기기 원클릭이 no-cli로 죽는다 (스테이징 3.4 확인)');

const ws = 'smoke-co';
const r = await startClaudeSetupToken(ws);
if (!r.ok) fail(`원클릭 시작 실패: ${JSON.stringify(r)}`);

// ②③ 15초 안에 authUrl과 코드 프롬프트 관측 — 헤드리스라 브라우저 open은 실패해도 CLI는 URL을 출력한다
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < 15_000) {
  await new Promise((res) => setTimeout(res, 500));
  last = setupTokenStatus(ws);
  if (last.status === 'failed') fail(`원클릭이 완주 전에 죽음: ${last.error}`);
  if (last.authUrl && last.awaitCode) break;
}
if (!last?.authUrl) fail(`인증 URL 미관측(15s) — status=${last?.status}`);
if (!last.authUrl.startsWith('https://claude.com/')) fail(`authUrl 형식 이상: ${last.authUrl.slice(0, 60)}`);
if (!last.awaitCode) fail('코드 프롬프트(awaitCode) 미도달 — 코드 왕복 UI가 열리지 않는다');

console.log(`SMOKE OK: authUrl 관측(${last.authUrl.slice(0, 44)}…) + awaitCode 도달 (${Date.now() - t0}ms)`);
process.exit(0); // PTY 자식은 detach 안 됨 — 프로세스 종료로 함께 정리된다
