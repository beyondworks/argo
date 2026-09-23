// VPS 서버 연결 스크립트 배포본 생성 — integrations/server-connect/connect.py에 헤르메스·오픈클로 플러그인 파일을 넣어
// supabase/functions/msgr-bot/connect-bundle.js(엣지 함수가 /connect로 내려주는 원문)를 만든다.
// 플러그인 원본을 고치면 다시 돌린다: `node scripts/build-server-connect.mjs` (test/server-connect.test.mjs가 어긋남을 잡는다).
// 복사 규칙은 앱 번들과 같다(agents.rs copy_dir): node_modules·점 파일·__pycache__ 제외.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'supabase/functions/msgr-bot/connect-bundle.js');

function files(dir, base = dir, acc = {}) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, base, acc);
    else acc[relative(base, p).split('\\').join('/')] = readFileSync(p).toString('base64');
  }
  return acc;
}

export function buildConnectScript() {
  const src = readFileSync(join(ROOT, 'integrations/server-connect/connect.py'), 'utf8');
  const plugins = { hermes: files(join(ROOT, 'integrations/hermes-argo-msgr')), openclaw: files(join(ROOT, 'integrations/openclaw-argo-msgr')) };
  const line = 'PLUGINS = {}';
  if (src.split(line).length !== 2) throw new Error('connect.py: PLUGINS 자리를 찾지 못했습니다');
  const py = src.replace(line, `PLUGINS = ${JSON.stringify(plugins)}`);
  return `// 생성 파일 — 손으로 고치지 않는다. 원본: integrations/server-connect/connect.py + integrations/*-argo-msgr, 생성: scripts/build-server-connect.mjs\nexport const CONNECT_PY = ${JSON.stringify(py)};\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, buildConnectScript());
  console.log(`[build-server-connect] ${relative(ROOT, OUT)} (${statSync(OUT).size} bytes)`);
}
