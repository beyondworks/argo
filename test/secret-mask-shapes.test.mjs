// 가리는 범위가 줄지 않는다 — 모양 표 대조(총괄이 만든 차분 도구의 입력 묶음을 그대로 옮김). 기준 구현(test/helpers/mask-reference.mjs: origin/main의 maskKeyLike,
// feat/turn-trace 1e9333bd의 maskSecrets)이 가린 비밀 값은 새 구현도 가려야 한다. 비밀 값은 실행 중에 만드는 가짜다(소스에 한 줄로 두지 않는다).
// 모양 표 = 키 15종 + 가림 모양 88가지(헤더·CLI 인자·mysql -p·curl -u·URL(긴 스킴·@ 든 비밀번호)·KEY=VALUE(소문자 섞인 *_KEY·JSON·YAML·따옴표·닫히지 않은 따옴표)·PEM …)
// × 값 2종 × 앞 글자 22가지 × 뒤 글자 13가지. 이 표에서 5a95cd29가 놓친 것: 소문자가 섞인 이름의 `*_KEY=값`(isSecretName).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../src/secret-mask.mjs';
import { maskKeyLike } from '../src/runners/shared.mjs';
import { REF_MAIN_KEY_LIKE, refMaskSecrets } from './helpers/mask-reference.mjs';

const r = (n, abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') => Array.from({ length: n }, (_, i) => abc[(i * 7 + n) % abc.length]).join('');
const hex = (n) => r(n, '0123456789abcdef');
const UP = (n) => r(n, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
const b64u = (n) => r(n, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-');
const jwt = 'eyJ' + b64u(20) + '.' + 'eyJ' + b64u(24) + '.' + b64u(30);
const pw = 'Pw' + r(14) + '9';

// [이름, 만들기(값) → 글, 비밀 값]
const fam = [
  ['sk', 'sk-proj-' + b64u(40)], ['sk-ant', 'sk-ant-api03-' + b64u(60)], ['AIza', 'AIza' + b64u(35)], ['xai', 'xai-' + r(40)],
  ['jwt', jwt], ['glm', hex(32) + '.' + r(16)], ['ghp', 'ghp_' + r(36)], ['github_pat', 'github_pat_' + r(22) + '_' + r(40)],
  ['akia', 'AKIA' + UP(16)], ['xoxb', 'xoxb-' + r(12) + '-' + r(24)], ['glpat', 'glpat-' + r(20)], ['npm', 'npm_' + r(36)], ['hf', 'hf_' + r(34)],
].map(([n, v]) => [n, (x) => x, v]);
const shapes = [
  ['bearer', (v) => `Bearer ${v}`], ['bearer-lc', (v) => `bearer ${v}`], ['BEARER', (v) => `BEARER ${v}`], ['basic', (v) => `Basic ${v}`], ['token-hdr', (v) => `Token ${v}`],
  ['authz', (v) => `Authorization: Bearer ${v}`], ['bearer-nl', (v) => `Bearer\n${v}`], ['bearer-tab', (v) => `Bearer\t${v}`],
  ['cookie', (v) => `Cookie: session=${v}`], ['setcookie', (v) => `Set-Cookie: sid=${v}; Path=/`], ['cookie-lc', (v) => `cookie: sid=${v}`],
  ['--password', (v) => ` --password ${v}`], ['--password=', (v) => ` --password=${v}`], ['--token', (v) => ` --token ${v}`], ['--api-key', (v) => ` --api-key ${v}`],
  ['--apikey', (v) => ` --apikey ${v}`], ['-p-quoted', (v) => ` --password "${v} x"`], ['--secret', (v) => ` --secret ${v}`], ['--client-secret', (v) => ` --client-secret ${v}`],
  ['--auth-token', (v) => ` --auth-token ${v}`], ['--passwd', (v) => ` --passwd ${v}`], ['--pass', (v) => ` --pass ${v}`],
  ['mysql-p', (v) => `mysql -u root -p${v} db`], ['mysqldump-p', (v) => `mysqldump -h h -p${v}`], ['mariadb-p', (v) => `mariadb -p${v}`], ['mysql-later', (v) => `cd x && mysql -uroot -p${v}`],
  ['sshpass', (v) => `sshpass -p ${v} ssh h`], ['curl-u', (v) => `curl -u admin:${v} https://h`], ['curl-user', (v) => `curl --user admin:${v} https://h`], ['curl-u-q', (v) => `curl -u "admin:${v}" https://h`],
  ['url-pg', (v) => `postgres://admin:${v}@db.host:5432/app`], ['url-pgsql', (v) => `postgresql://admin:${v}@db.host/app`], ['url-asyncpg', (v) => `postgresql+asyncpg://admin:${v}@h/app`],
  ['url-srv', (v) => `mongodb+srv://admin:${v}@c.mongodb.net/db`], ['url-redis', (v) => `redis://default:${v}@h:6379`], ['url-https', (v) => `https://user:${v}@git.host/r.git`],
  ['url-jdbc', (v) => `jdbc:postgresql://admin:${v}@h/app`], ['url-longscheme', (v) => `postgresql+psycopg2+extra://admin:${v}@h/app`], ['url-at-in-pw', (v) => `https://u:${v}@x@h/p`],
  ['kv-env', (v) => `OPENAI_API_KEY=${v}`], ['kv-export', (v) => `export GITHUB_TOKEN=${v}`], ['kv-json', (v) => `{"password": "${v}"}`], ['kv-json-sq', (v) => `{'password': '${v}'}`],
  ['kv-yaml', (v) => `password: ${v}`], ['kv-camel', (v) => `apiKey=${v}`], ['kv-dburl', (v) => `DATABASE_URL=${v}`], ['kv-client', (v) => `client_secret=${v}`],
  ['kv-svc', (v) => `SUPABASE_SERVICE_ROLE_KEY=${v}`], ['kv-mid', (v) => `MY_TOKEN_X=${v}`], ['kv-pwd', (v) => `pwd=${v}`], ['kv-auth', (v) => `auth: ${v}`],
  ['kv-dotted', (v) => `db.password=${v}`], ['kv-dash', (v) => `api-key: ${v}`], ['kv-spaces', (v) => `PASSWORD   =   ${v}`], ['kv-quoted-key', (v) => `"api_key":"${v}"`],
  ['kv-longname', (v) => `${'A'.repeat(90)}_PASSWORD=${v}`], ['kv-unclosed', (v) => `"password": "${v}`], ['kv-colon-nospace', (v) => `secret:${v}`],
  ['kv-SECRET_X', (v) => `SECRET_VALUE=${v}`], ['kv-x_secret', (v) => `x_secret=${v}`], ['kv-Token', (v) => `Token=${v}`],
  // 2차 확장
  ['authz-nospace', (v) => `Authorization:Bearer ${v}`], ['hdr-token', (v) => `-H "Authorization: token ${v}"`], ['x-api-key', (v) => `x-api-key: ${v}`],
  ['apikey-hdr', (v) => `apikey: ${v}`], ['api_key-dq', (v) => `api_key="${v}"`], ['toml-pw', (v) => `password = "${v}"`], ['Password-cap', (v) => `Password=${v}`],
  ['PASS', (v) => `PASS=${v}`], ['token-sq', (v) => `token: '${v}'`], ['--password-sq', (v) => ` --password='${v} y'`], ['mysql-p-q', (v) => `mysql -p'${v}' db`],
  ['mysql-p-dq', (v) => `mysql -p"${v}" db`], ['curl-u-attached', (v) => `curl -uadmin:${v} https://h`], ['curl-u-eq', (v) => `curl --user=admin:${v} https://h`],
  ['env-lc-key', (v) => `next_public_supabase_anon_KEY=${v}`], ['docker-e', (v) => `docker run -e OPENAI_API_KEY=${v} img`], ['set-x', (v) => `set OPENAI_API_KEY=${v}`],
  ['ps1', (v) => `$env:OPENAI_API_KEY="${v}"`], ['json-nested', (v) => `{"auth":{"token":"${v}"}}`], ['yaml-indent', (v) => `  api_key:   ${v}`],
  ['url-q-token', (v) => `https://h/cb?access_token=${v}&x=1`], ['url-q-key', (v) => `https://h/x?key=${v}`], ['url-user-only', (v) => `https://${v}@github.com/o/r`],
  ['pem', (v) => `-----BEGIN RSA PRIVATE KEY-----\n${v}\n${v}\n-----END RSA PRIVATE KEY-----`], ['pem-ec', (v) => `-----BEGIN EC PRIVATE KEY-----\n${v}\n-----END EC PRIVATE KEY-----`],
  ['pem-open', (v) => `-----BEGIN PRIVATE KEY-----\n${v}`], ['pem-openssh', (v) => `-----BEGIN OPENSSH PRIVATE KEY-----\n${v}\n-----END OPENSSH PRIVATE KEY-----`],
];
const pre = ['', ' ', '\n', '-', '.', '=', ':', '"', "'", '(', '[', '{', ',', '/', 'x', '_', '\t', 'token-', 'id=', '$ ', 'a b c ', '>'];
const suf = ['', ' ', '\n', '"', "'", ',', ')', '.', ';', '&', '/', 'x', '\nnext line'];


const leaks = (out, v) => { if (v.length < 12) return out.includes(v); for (let i = 0; i + 10 <= v.length; i += 1) if (out.includes(v.slice(i, i + 10))) return true; return false; }; // 값의 10자 조각이 하나라도 남으면 샌 것

function sweep(label, cases, refFn, newFn) {
  let total = 0; let refHid = 0; const bad = [];
  for (const [text, v] of cases) {
    total += 1;
    const a = refFn(text);
    if (leaks(a, v)) continue; // 기준도 못 가리는 입력은 비교 대상이 아니다
    refHid += 1;
    const b = newFn(text);
    if (leaks(b, v) && bad.length < 8) bad.push(`${JSON.stringify(text).slice(0, 140)} → ${JSON.stringify(b).slice(0, 140)}`);
  }
  return { label, total, refHid, bad };
}
const keyCases = () => { const out = []; for (const [, , v] of fam) for (const p of pre) for (const s of suf) out.push([p + v + s, v]); return out; };
const shapeCases = () => { const out = []; for (const [, mk] of shapes) for (const v of [pw, fam[0][2]]) for (const p of pre) for (const s of suf) out.push([p + mk(v) + s, v]); return out; };

test('(a) maskKeyLike — 지금 main이 가리던 키 모양은 새 구현도 모두 가린다(키 13종 × 앞 22 × 뒤 13)', () => {
  const r2 = sweep('maskKeyLike', keyCases(), REF_MAIN_KEY_LIKE, maskKeyLike);
  assert.ok(r2.refHid > 1000, `비교가 헛돈다: ${JSON.stringify({ total: r2.total, refHid: r2.refHid })}`);
  assert.deepEqual(r2.bad, [], `main이 가리던 키가 새 구현에서 샌다:\n${r2.bad.join('\n')}`);
});
test('(b) maskSecrets — 1e9333bd가 가리던 키 모양은 새 구현도 모두 가린다', () => {
  const r2 = sweep('maskSecrets/keys', keyCases(), refMaskSecrets, maskSecrets);
  assert.ok(r2.refHid > 3000, `비교가 헛돈다: ${JSON.stringify({ total: r2.total, refHid: r2.refHid })}`);
  assert.deepEqual(r2.bad, [], `1e9333bd가 가리던 키가 새 구현에서 샌다:\n${r2.bad.join('\n')}`);
});
test('(b) maskSecrets — 모양 표 전체(88가지 × 값 2 × 앞 22 × 뒤 13): 1e9333bd가 가리던 비밀은 새 구현도 모두 가린다', () => {
  const r2 = sweep('maskSecrets/shapes', shapeCases(), refMaskSecrets, maskSecrets);
  assert.ok(r2.total > 50_000 && r2.refHid > 20_000, `비교가 헛돈다: ${JSON.stringify({ total: r2.total, refHid: r2.refHid })}`);
  assert.deepEqual(r2.bad, [], `1e9333bd가 가리던 비밀이 새 구현에서 샌다:\n${r2.bad.join('\n')}`);
});
