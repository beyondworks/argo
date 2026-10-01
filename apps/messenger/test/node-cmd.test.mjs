// 회사 서버 안내(검수 #797 LOW-2) — "명령 앞에 함께 넣을 항목"이 세 줄 KEY=value면 그대로 붙여 넣을 때 명령에 전달되지 않는다.
// 한 줄 접두(KEY=값 KEY=값 … 명령)여야 sh가 그 명령의 환경변수로 넘긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { NODE_ENV_PREFIX } from '../src/node-cmd.mjs';

test('접두는 한 줄이고, 자리표시자를 실제 값으로 바꿔 명령 앞에 이으면 그 명령이 환경변수를 받는다', () => {
  assert.doesNotMatch(NODE_ENV_PREFIX, /\n/);
  const line = NODE_ENV_PREFIX.replace('<email>', 'svc@example.test').replace('<password>', 'pw1').replace('<folder>', 'data-folder'); // 경로 모양 값('/data')은 Windows Git Bash가 C:/Program Files/Git/data로 바꿔 버린다(CI 실측)
  const out = execFileSync('sh', ['-c', `${line} node -e "console.log([process.env.ARGO_NODE_EMAIL, process.env.ARGO_NODE_PASSWORD, process.env.ARGO_ROOT].join('|'))"`], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  assert.equal(out, 'svc@example.test|pw1|data-folder');
});

test('세 줄로 따로 붙이면(예전 안내) 명령이 받지 못한다 — 이 테스트가 접두 형식이 필요한 이유를 잠근다', () => {
  const out = execFileSync('sh', ['-c', `ARGO_ROOT=/data
node -e "console.log(String(process.env.ARGO_ROOT))"`], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  assert.equal(out, 'undefined');
});

test('앱: 안내는 접두 상수 한 줄(code 한 개)로 그리고, 라벨은 "한 줄로 이어서"', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<code>\{NODE_ENV_PREFIX\} &lt;\{t\('org\.node\.env\.cmd'\)\}&gt;<\/code>/);
  assert.doesNotMatch(app, /ARGO_NODE_EMAIL=<email>\\nARGO_NODE_PASSWORD/);
});
