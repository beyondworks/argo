// argo CLI 적재 — 서버 타르볼(stage-server.mjs)과 데스크톱 사이드카(stage-sidecar.mjs)가 같은 함수를 쓴다(설계 2-6, 2026-10-01).
// Next standalone 추적은 **서버가 쓰는** 파일만 싣는다 — CLI 전용(src/cli 등)은 빠지고, 서버가 쓰는 패키지도 일부 파일만 실린 사본이다
// (실측 0.1.91 설치본: zod 415/718, MCP SDK 346/693, ajv 64/466 — 검토 L-g). 그래서 src는 통째로, CLI가 bare import하는 패키지는 **전체**를 덮어 복사한다
// (같은 루트 node_modules의 같은 버전이라 상위 집합 — 남이 추적한 일부 사본에 기대지 않는다).
// 호출부 절차를 바꾸면 두 스크립트 모두 — 이 파일 하나가 두 트리의 CLI 계약이다. 모듈·패키지 누락은 test/stage-cli-tree.test.mjs가 적재한 트리에서 실제로 실행해 잡는다.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// `src`·`bin`의 bare import 전수(2026-09-30) — 새 패키지를 import하면 여기에 더한다(stage-cli-tree 테스트가 빠뜨림을 잡는다).
export const CLI_DEPS = ['@supabase/supabase-js', '@modelcontextprotocol/sdk', 'zod', 'yaml', 'smol-toml', 'json5'];

/** tree(서버 트리 루트)에 argo CLI를 싣는다. env의 publicEnv 두 이름(URL·anon 키)이 둘 다 있으면 bin/argo-public.json을 만든다(공개 값뿐).
    ⚠ 서버 타르볼은 NEXT_PUBLIC_*를 쓰면 안 된다 — Next 빌드에 인라인돼 셀프호스트 웹이 인증 모드가 된다(그래서 호출부가 이름을 정한다).
    반환: { deps(복사한 패키지 수), publicConfig(argo-public.json을 만들었는가) } */
export function stageCli({ root, tree, env = process.env, publicEnv = ['ARGO_CLI_SUPABASE_URL', 'ARGO_CLI_SUPABASE_ANON_KEY'] }) {
  cpSync(join(root, 'src'), join(tree, 'src'), { recursive: true });
  mkdirSync(join(tree, 'bin'), { recursive: true });
  cpSync(join(root, 'bin', 'argo.mjs'), join(tree, 'bin', 'argo.mjs'));
  if (!existsSync(join(tree, 'instrumentation-node.mjs'))) cpSync(join(root, 'instrumentation-node.mjs'), join(tree, 'instrumentation-node.mjs'));
  // 의존성 폐포(dependencies·optional·peer 중 설치된 것) — 이미 있는 패키지도 전체로 덮는다.
  const seen = new Set(); const queue = [...CLI_DEPS];
  while (queue.length) {
    const name = queue.shift(); if (seen.has(name)) continue; seen.add(name);
    const src = join(root, 'node_modules', name); if (!existsSync(join(src, 'package.json'))) continue; // 선택 의존성이 설치 안 된 경우
    const dest = join(tree, 'node_modules', name);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true, force: true });
    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    queue.push(...Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }));
  }
  const url = env[publicEnv[0]]?.trim(); const anonKey = env[publicEnv[1]]?.trim();
  const publicConfig = !!(url && anonKey);
  if (publicConfig) writeFileSync(join(tree, 'bin', 'argo-public.json'), `${JSON.stringify({ url, anonKey })}\n`);
  return { deps: seen.size, publicConfig };
}
