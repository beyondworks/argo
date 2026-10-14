// 빌드 때 구운 서버 전용 값 — 앱 사이드카(next start)와 셀프호스트 타르볼은 CI 시크릿이 process.env에 없다(release.yml은 NEXT_PUBLIC_*만 빌드에 넘긴다).
// 그래서 스테이징(scripts/bake-server-env.mjs)이 서버 트리 루트에 BAKED_ENV_FILE을 쓰고, 서버가 process.env에 값이 없을 때만 여기서 읽는다.
//  · 이름은 BAKED_ENV_NAMES 허용 목록만 — 파일에 다른 키가 있어도 읽지 않는다.
//  · process.env에 옮겨 담지 않는다 — 에이전트 턴·MCP 서버 같은 자식 프로세스가 물려받지 않게(읽는 쪽이 이 함수를 부를 때만 값이 나온다).
//  · 클라이언트 번들에서 import하지 않는다(node:fs) — 값은 'use client' 화면에 닿지 않는다. 발행 잡이 .next/static에 값이 없는지 grep한다(scripts/assert-not-in-client.mjs).
//  · 위치: 서버 트리 루트 = 사이드카의 current_dir(src-tauri lib.rs)·셀프호스트 WorkingDirectory(install.sh) = server.js가 있는 폴더.
//    process.cwd()와 server.js 경로(process.argv[1]) 두 곳을 본다. 레포 개발(next dev)에서는 파일이 없어 종전대로 process.env(.env.local)만.
// 구글 '데스크톱 앱' OAuth 클라이언트 secret은 구글 문서상 기밀로 취급하지 않는 값(설치형 앱에 넣는 것이 정상)이지만, 저장소에는 이름만 둔다(검수 F4).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BAKED_ENV_FILE = 'argo-server-config.json';
export const BAKED_ENV_NAMES = Object.freeze(['ARGO_CONNECTOR_GOOGLE_CLIENT_SECRET']);

let cache = null; // { dirsKey, values }
const readBaked = (dir) => {
  try {
    const o = JSON.parse(readFileSync(join(dir, BAKED_ENV_FILE), 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
};
/** 구운 값들(허용 이름만). dirs는 시험 주입용 — 기본은 cwd와 server.js 폴더. 한 번 읽으면 같은 dirs에 대해 기억한다(파일은 설치본에서 바뀌지 않는다). */
export function bakedEnv({ dirs } = {}) {
  const list = dirs ?? [process.cwd(), ...(process.argv[1] ? [dirname(process.argv[1])] : [])];
  const key = list.join('\0');
  if (cache?.key === key) return cache.values;
  const values = {};
  for (const d of list) {
    const o = readBaked(d); if (!o) continue;
    for (const n of BAKED_ENV_NAMES) if (values[n] === undefined && typeof o[n] === 'string' && o[n].trim()) values[n] = o[n].trim();
  }
  cache = { key, values };
  return values;
}
/** 서버 설정값 — 실행 환경(process.env)이 먼저, 없으면 구운 값. 허용 목록 밖의 이름은 process.env만 본다. */
export function serverEnv(name, opts) {
  const v = process.env[name]?.trim();
  if (v) return v;
  return BAKED_ENV_NAMES.includes(name) ? bakedEnv(opts)[name] : undefined;
}
export function _resetBakedEnvForTest() { cache = null; }
