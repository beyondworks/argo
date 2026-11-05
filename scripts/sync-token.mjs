#!/usr/bin/env node
// 외부 동기화 통로 토큰 발급·회수·목록 (src/sync-token.mjs). 평문 토큰은 화면에 찍지 않는다.
//
//   node scripts/sync-token.mjs issue <이름> --ws <회사 id> --out <토큰 파일> [--scope vault-notes] [--rotate]
//   node scripts/sync-token.mjs revoke <이름>
//   node scripts/sync-token.mjs list
//
// ARGO_ROOT(상주는 launchd env의 값)를 서버와 같게 줘야 서버가 읽는 표에 들어간다.
// issue는 32바이트 무작위 토큰을 만들어 --out 파일(권한 600, 이미 있으면 --rotate 없이는 거절)에 쓰고, 서버 표에는 sha256만 남긴다.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SYNC_SCOPES, tokenHash, syncTokenFile } from '../src/sync-token.mjs';

const [cmd, name, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const flag = (k) => rest.includes(`--${k}`);
const die = (m) => { console.error(m); process.exit(1); };

const file = syncTokenFile();
async function load() {
  try { const j = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(j?.tokens) ? j.tokens : []; }
  catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
}
async function save(tokens) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

if (cmd === 'list') {
  for (const t of await load()) console.log(`${t.name}\tws=${t.ws}\tscope=${t.scope}\tcreated=${t.createdAt}`);
  console.log(`표: ${file}`);
} else if (cmd === 'revoke') {
  if (!name) die('이름이 필요합니다');
  const tokens = await load();
  const next = tokens.filter((t) => t.name !== name);
  if (next.length === tokens.length) die(`없는 이름: ${name}`);
  await save(next);
  console.log(`회수함: ${name}`);
} else if (cmd === 'issue') {
  const ws = opt('ws'); const out = opt('out'); const scope = opt('scope') ?? 'vault-notes';
  if (!name || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) die('이름은 영문 소문자·숫자·하이픈(2~41자)');
  if (!ws || !/^[A-Za-z0-9_-]{1,80}$/.test(ws)) die('--ws <회사 id>가 필요합니다');
  if (!out) die('--out <토큰 파일>이 필요합니다');
  if (!SYNC_SCOPES[scope]) die(`없는 범위: ${scope} (가능: ${Object.keys(SYNC_SCOPES).join(', ')})`);
  const exists = await stat(out).then(() => true, () => false);
  if (exists && !flag('rotate')) die(`토큰 파일이 이미 있습니다: ${out} (--rotate로 교체)`);
  const token = `argo_sync_${randomBytes(32).toString('base64url')}`;
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, `${token}\n`, { mode: 0o600 });
  await chmod(out, 0o600);
  const tokens = (await load()).filter((t) => t.name !== name);
  tokens.push({ name, ws, scope, sha256: tokenHash(token), createdAt: new Date().toISOString() });
  await save(tokens);
  console.log(`발급함: ${name} (ws=${ws}, scope=${scope}) → 토큰 파일 ${out}, 서버 표 ${file}`);
} else {
  die('사용법: sync-token.mjs issue <이름> --ws <회사> --out <파일> | revoke <이름> | list');
}
