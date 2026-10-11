// 앱 버전 하나 — 메신저 기기 심박(gateway/msgr.mjs)·러너 턴 프로브 지문(runner-health.mjs)·codex OAuth 헤더(runners/codex-oauth.mjs)가 여기서 읽는다.
// 번들(Next — 설치본 사이드카·상주 :3001·dev)에서는 import.meta.url이 **빌드 기기의 절대 경로**로 바뀌어 박힌다(설치본 0.1.101 실측:
// file:///Users/runner/work/argo/argo/src/…) — 사용자 기기에서 package.json을 못 찾아 버전이 '0.0.0'·null이 됐다. 그래서 번들에서는
// next.config가 package.json에서 넣는 NEXT_PUBLIC_APP_VERSION(상단바 버전 표시와 같은 값)이 글자로 박힌 것을 쓰고, 번들 밖(node로 src를
// 바로 실행 — argo CLI 단독 설치·앱 server 트리의 CLI·시험)은 트리 루트의 package.json을 읽는다(이 파일은 src/ 바로 아래에 있어야 한다).
// 버전을 읽는 사본을 새로 만들지 않는다 — test/app-version.test.mjs ③이 막는다. 못 읽으면 null.
import { createRequire } from 'node:module';

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || (() => { try { return createRequire(import.meta.url)('../package.json').version ?? null; } catch { return null; } })();
