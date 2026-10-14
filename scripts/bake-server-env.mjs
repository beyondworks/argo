// 서버 전용 빌드 값을 스테이징한 서버 트리에 굽는다 — stage-sidecar.mjs(앱 번들)·stage-server.mjs(셀프호스트 타르볼)가 같은 함수를 쓴다.
// 값은 CI 시크릿(같은 이름의 환경변수)에서만 온다. 없으면(포크·로컬 빌드) 파일을 만들지 않고, 그 빌드의 커넥터는 종전대로 '준비 중'이다.
// 정의·읽는 쪽은 src/server-baked-env.mjs. 반환은 구운 **이름**뿐 — 값은 로그에 내지 않는다.
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BAKED_ENV_FILE, BAKED_ENV_NAMES } from '../src/server-baked-env.mjs';

export function bakeServerEnv({ tree, env = process.env }) {
  const out = {};
  for (const n of BAKED_ENV_NAMES) { const v = env[n]?.trim(); if (v) out[n] = v; }
  const file = join(tree, BAKED_ENV_FILE);
  rmSync(file, { force: true }); // 앞 스테이징이 남긴 값이 시크릿 없는 빌드에 섞이지 않게
  const names = Object.keys(out);
  if (names.length) writeFileSync(file, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  return { names, file: names.length ? file : null };
}
