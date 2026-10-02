// 크루 답 속 로컬 파일 → 메신저 첨부(게이트웨이를 거치는 크루 답 공통 — 러너 무관. 외부 봇은 자기 기기 파일이라 대상 밖).
// 실사례(2026-10-02, 운영 읽기 전용 확인): 페퍼(codex) 답이 `[페퍼-아바타.png](/Users/…/vault/projects/…/페퍼-아바타.png)`와
// `![페퍼 아바타](같은 경로)`였고 첨부는 0건 — extractFileRefs는 상대 경로(files/·projects/·_imported/)만 잡아
// 메신저에선 눌러도 반응 없는 링크와 깨진 그림만 남았다.
//
// 보안 경계(절대): 파일을 realpath로 풀어 **그 회사 vault의 첨부 구역(SERVE_PREFIXES — files/·projects/·_imported/, 각 구역의 realpath)** 안일 때만 붙인다.
// 구역 안이어도 결과물 확장자(tg-format ATTACH_EXT — 텔레그램과 같은 목록)만 붙이고, _imported/unsorted/(가져오기가 분류 못 한 개인 파일)는
// 구역에서 뺀다 — 분리 검수 M-1(2026-10-02): 마크다운 링크 하나로 _imported/unsorted/…/credentials.json·secrets.yaml·wallet.kdbx 등이 방에 올라갔다.
// 회사 루트 전체가 아닌 이유: 루트에는 connections.json·mcp.json·capabilities.json 같은 설정이, vault에는 journal/·notes/ 같은 기억이 있다.
// 심링크로 밖을 가리키는 것·`..`·다른 회사·홈의 다른 폴더는 realpath 결과가 구역 밖이라 걸린다. 구역 안 경로라도 숨김 조각(.env, .ssh 등)·
// env 이름은 거부한다. 읽을 때 다시 realpath·O_NOFOLLOW·inode 대조로 판정한다(계획과 읽기 사이 바꿔치기 방어).
//
// 본문: 첨부 대상 후보(로컬 파일을 가리키는 마크다운 이미지·링크)는 성공·실패와 무관하게 본문에서 경로를 지운다 — 방에는 손님도 있고
// 절대 경로에는 OS 사용자 이름·폴더 구조가 들어 있다(D26과 같은 이유). 이미지는 첨부로 대신하고(실패면 대체 글자), 링크는 글자만 남긴다.
// 구역 밖 절대 경로가 후보인지는 **파일이 있는지가 아니라 경로 위치**로 정한다(2차 검수 N-5, 3차 F-3): 홈·작업 루트·임시 폴더 아래면
// 후보(경로를 지우고 '밖이거나 없는 파일' 안내 하나 — 사용자 이름·폴더 구조가 드러나는 자리), 그 밖(`/login`·`/docs/guide.pdf`·`/etc/hosts`)은
// 본문에 그대로 둔다(파일은 나가지 않는다). 있는 파일과 없는 파일이 같은 결과라 링크 하나로 남의 경로에 파일이 있는지 알아낼 수 없다.
// 코드 블록·인라인 코드 안은 손대지 않는다(예시 코드를 망가뜨리지 않게).
import { open, realpath, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths, WS_ROOT } from '../workspace.mjs';
import { SERVE_PREFIXES } from '../artifact-zones.mjs';
import { ATTACH_EXT, extractFileRefs } from '../tg-format.mjs';
import { pick } from './protocol.mjs';

export const ATTACH_MAX = 25 * 1024 * 1024; // 첨부 상한 — 앱 업로드·DB 정책(26214400)과 같은 값
export const REPLY_FILES_MAX = 10;          // 한 답에 붙이는 파일 수 상한(Storage 업로드·첨부 행 폭주 방지)
export const ROUTINE_FILES_MAX = 3;         // 루틴 결과 글 상한 — 일정마다 반복되는 글이라 더 낮게(분리 검수 M-5)

// 마크다운 이미지·링크: !?[글자](대상) — 대상 안 괄호는 한 겹까지(이름 (1).pdf). 펼친 반복(겹치는 갈래 없음)이고 글자는 다음 `[`를 넘지 않아 입력 길이에 선형이다 —
// 예전 꼴(지연 반복 + \s* + 제목 선택)은 `[a](x` 뒤 공백 8천 개에 282초가 걸렸다(실측). 제목("…")은 정규식 밖에서 뗀다(splitTitle).
const MD_LINK = /(!?)\[([^[\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
const ZONES = SERVE_PREFIXES.map((z) => z.replace(/\/$/, ''));
const SECRET_NAME = /(^|\.)env(\.|$)|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|p12|pfx|key|kdbx|sqlite3?|db)$/i; // 경로의 모든 조각
const WORDS = 'credentials?|secrets?|tokens?|auth|passwords?|passwd|api[_-]?keys?|private[_-]?keys?|service[_-]?accounts?';
const SECRET_WORD = new RegExp(`(^|[^a-z0-9])(${WORDS})([^a-z0-9]|$)`, 'i');         // 파일 이름(마지막 조각) 안의 낱말
const SECRET_CAMEL = /[a-z0-9](Tokens?|Secrets?|Credentials?|Passwords?|ApiKeys?|PrivateKeys?)(?![a-z])/; // accessToken.md·clientSecret.json 같은 camelCase(대소문자 구분)
const SECRET_DIR = new RegExp(`^(${WORDS})$`, 'i');                                     // 폴더 조각은 이름 전체가 그 낱말일 때만(auth-flow 같은 프로젝트 폴더는 통과)
const UNSORTED = 'unsorted';                                                            // _imported/unsorted/ — 첨부 구역에서 뺀다
const secretName = (name) => name.startsWith('.') || SECRET_NAME.test(name) || SECRET_WORD.test(name) || SECRET_CAMEL.test(name);
const secretDir = (seg) => seg.startsWith('.') || SECRET_NAME.test(seg) || SECRET_DIR.test(seg);

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
/** `대상 "제목"`에서 제목을 뗀다(문자열 처리 — 정규식 되돌아가기 없음). */
function splitTitle(raw) {
  const d = raw.trim();
  if (!d.endsWith('"') || d.length < 2) return d;
  const open = d.lastIndexOf('"', d.length - 2);
  return open > 0 && /\s/.test(d[open - 1]) ? d.slice(0, open).trim() : d;
}

/** 마크다운 대상 → 로컬 경로 후보(절대 경로) 또는 null(웹 주소·첨부 구역 밖 상대 경로 — 손대지 않는다). */
function localTarget(dest, vault) {
  let d = splitTitle(dest);
  if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1).trim();
  if (!d) return null;
  if (/^file:/i.test(d)) { try { return fileURLToPath(d); } catch { return null; } }
  if (/^[A-Za-z]:[\\/]/.test(d)) return isAbsolute(d) ? d : null; // 윈도우 드라이브 경로 — 이 OS에서 절대 경로일 때만
  if (/^[a-z][a-z0-9+.-]*:/i.test(d) || d.startsWith('#')) return null; // https:·mailto:·앵커
  d = safeDecode(d);
  if (d === '~' || d.startsWith('~/')) return join(homedir(), d.slice(1));
  if (isAbsolute(d)) return d;
  const rel = d.replace(/^\.\//, '').replace(/^vault\//, ''); // 상대 경로는 기존 규칙(extractFileRefs) 그대로 — vault 기준 첨부 구역만
  return ZONES.some((z) => rel.startsWith(`${z}/`)) ? join(vault, rel) : null;
}

// 구역 밖 절대 경로 중 지우는 자리 — 홈·작업 루트·임시 폴더 아래(사용자 이름·폴더 구조가 드러나는 자리). macOS·윈도우는 대소문자를 무시한다(/users/X도 홈).
const FOLD = process.platform === 'darwin' || process.platform === 'win32' ? (p) => p.toLowerCase() : (p) => p;
const PRIVATE_ROOTS = [...new Set([homedir(), WS_ROOT, tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].filter(Boolean).map((r) => FOLD(resolve(r))))];
const within = (p, root) => { const rel = relative(root, p); return rel === '' || (!!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const privatePath = (abs) => PRIVATE_ROOTS.some((r) => within(FOLD(resolve(abs)), r));

/** 존재하는 가장 가까운 부모 폴더의 realpath가 첨부 구역(루트 포함) 안인가. */
async function parentInZone(abs, roots) {
  for (let d = dirname(abs); ; d = dirname(d)) {
    const r = await realpath(d).catch(() => null);
    if (r) return roots.some(({ root }) => within(r, root));
    if (dirname(d) === d) return false;
  }
}

async function zoneRoots(vault) { // [{ zone, root }] — 구역 이름은 _imported/unsorted 제외 판정용
  const roots = await Promise.all(ZONES.map(async (zone) => ({ zone, root: await realpath(join(vault, zone)).catch(() => null) })));
  return roots.filter((r) => r.root);
}
const zoneLiterals = (vault) => ZONES.map((zone) => ({ zone, root: resolve(vault, zone) })); // 풀지 못한 경로(없는 파일)의 글자 그대로 판정용

/** 경로가 어느 첨부 구역 아래인지(글자 그대로의 포함 관계만) — { zone, segs } 또는 null. */
function zoneRel(path, roots) {
  for (const { zone, root } of roots) {
    const rel = relative(root, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
    return { zone, segs: rel.split(sep) };
  }
  return null;
}
/** realpath가 첨부 구역 안이고(_imported/unsorted 제외) 숨김·비밀 이름 조각이 없을 때만 true. */
function inZone(real, roots) {
  const z = zoneRel(real, roots);
  if (!z) return false;
  if (z.zone === '_imported' && z.segs.length > 1 && z.segs[0].toLowerCase() === UNSORTED) return false; // 대소문자 무시 FS(macOS)에서 Unsorted/ 우회 방지
  return !z.segs.slice(0, -1).some(secretDir) && !secretName(z.segs[z.segs.length - 1]);
}

const reasonText = (kind, lang, max = REPLY_FILES_MAX) => ({
  missing: pick('파일이 없습니다', 'file not found', lang),
  outside: pick('작업 폴더 밖이거나 없는 파일이라 첨부하지 않았습니다', 'outside the company work folder or not found — not attached', lang), // 밖·없음을 한 사유로(N-5)
  secret: pick('비밀 정보가 담긴 이름으로 보여 보내지 않았습니다(이름을 바꾸면 보낼 수 있습니다)', 'name looks like it holds secrets — not sent (rename it to send)', lang), // 낱말 오탐이면 이름만 바꿔 다시 보낸다(F-4)
  hardlink: pick('하드 링크라서 보내지 않았습니다', 'hard link — not sent', lang),
  type: pick('첨부하지 않는 파일 형식입니다', 'file type not attached', lang),
  big: pick('25MB 초과', 'over 25MB', lang),
  many: pick(`한 답에 최대 ${max}개까지 첨부합니다`, `at most ${max} files per reply`, lang),
}[kind]);

/** 판정 하나 — { ok:true, abs, name, bytes } 또는 { ok:false, name, kind } 또는 { skip:true }(첨부 후보가 아님 — 본문·안내 모두 손대지 않는다).
    풀지 못한 경로(없는 파일)는 글자 그대로 구역 안이면 '없음', 구역 밖이면 후보가 아니다 — `/login`·`/api/v1/users` 같은 웹 경로 링크를
    로컬 파일로 보고 본문에서 지우고 '작업 폴더 밖' 안내를 붙이던 것(분리 검수 L-2). 있는 구역 밖 파일은 그대로 '밖'으로 막는다. */
async function judge(abs, roots, literals) {
  const shown = basename(abs) || 'file';
  // 경로 중간 조각은 realpath 기준 구역 상대 경로로 본다 — 실제 루트가 ~/.argo/workspaces라 절대 경로 전체의 숨김 조각을 보면 정상 파일까지 막힌다.
  // realpath는 파일 내용을 읽지 않는다(.env가 구역 안 다른 파일을 가리키는 심링크여도 아래 이름 판정으로 거부).
  let real = null; let gone = false;
  try { real = await realpath(abs); } catch (e) { gone = e?.code === 'ENOENT' || e?.code === 'ENOTDIR'; }
  if (!real || !zoneRel(real, roots)) {
    // 글자 그대로 구역 안인데 없는 파일은 '없음' — 단, 존재하는 가장 가까운 부모의 realpath도 구역 안일 때만(F-2: 구역 안 심링크 폴더를 거쳐
    // 밖을 가리키면 있는 파일은 '밖', 없는 파일은 '없음'으로 갈려 존재 여부가 드러났다).
    const lexical = zoneRel(resolve(abs), [...literals, ...roots]);
    if (!real && gone && lexical && await parentInZone(resolve(abs), roots)) return { ok: false, name: shown, kind: 'missing' };
    // 그 밖(없음·밖·권한 오류)은 존재와 무관하게 위치로만 가른다 — 구역 글자·홈·작업 루트·임시 폴더 아래면 지우고 안내 하나, 아니면 그대로(N-5·F-3)
    if (!lexical && !privatePath(abs)) return { skip: true };
    return { ok: false, name: shown, kind: secretName(shown) ? 'secret' : 'outside' }; // 이름 판정은 존재와 무관(쓴 이름만 본다)
  }
  if (secretName(shown) || secretName(basename(real))) return { ok: false, name: shown, kind: 'secret' };
  if (!inZone(real, roots)) return { ok: false, name: shown, kind: 'outside' }; // _imported/unsorted·비밀 이름 폴더
  if (!ATTACH_EXT.test(basename(real))) return { ok: false, name: basename(real), kind: 'type' }; // 실제 파일 이름 기준(심링크 이름을 .pdf로 붙여도 소용없다)
  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) return { ok: false, name: shown, kind: 'missing' };
  if (st.nlink > 1) return { ok: false, name: shown, kind: 'hardlink' }; // 하드 링크 — 구역 밖 파일과 같은 내용일 수 있다(realpath로 못 가른다, N-4)
  if (st.size > ATTACH_MAX) return { ok: false, name: basename(real), kind: 'big' };
  return { ok: true, abs: real, name: basename(real), bytes: st.size };
}

/** 답 본문 → { body, files, fails }. body = 로컬 경로를 지운 본문(게시용), files = 붙일 파일(구역 안 realpath, 중복 제거, 상한),
    fails = 방에 보여도 되는 실패 사유({ name, reason }). wsId 기준 첨부 구역 밖은 절대 files에 들어가지 않는다. */
export async function planReplyFiles(wsId, text, { lang = 'ko', max = REPLY_FILES_MAX } = {}) {
  const src = String(text ?? '');
  const vault = paths(wsId).vault;
  const roots = await zoneRoots(vault);
  const literals = zoneLiterals(vault);
  const files = []; const fails = []; const seen = new Map(); // 후보 키(realpath 또는 쓴 경로) → 판정
  const take = async (abs) => {
    const j = await judge(abs, roots, literals);
    if (j.skip) return j;
    const key = j.ok ? j.abs : abs;
    if (seen.has(key)) return seen.get(key);
    let out = j;
    if (j.ok && files.length >= max) out = { ok: false, name: j.name, kind: 'many' };
    seen.set(key, out); if (key !== abs) seen.set(abs, out);
    if (out.ok) files.push({ abs: out.abs, name: out.name, bytes: out.bytes });
    else if (!fails.some((f) => f.key === key)) fails.push({ key, name: out.name, reason: reasonText(out.kind, lang, max) });
    return out;
  };
  // 1) 코드 밖의 마크다운 이미지·링크 — 순서대로 판정하고 경로를 지운다
  const parts = []; let last = 0; let removedImage = false;
  for (const m of src.matchAll(CODE)) { parts.push({ text: src.slice(last, m.index), code: false }, { text: m[0], code: true }); last = m.index + m[0].length; }
  parts.push({ text: src.slice(last), code: false });
  for (const part of parts) {
    if (part.code) continue;
    let out = ''; let at = 0;
    for (const m of part.text.matchAll(MD_LINK)) {
      const abs = localTarget(m[3], vault);
      if (!abs) continue;
      const j = await take(abs);
      if (j.skip) continue; // 첨부 후보가 아니다(웹 경로 링크 등) — 원문 그대로
      const label = m[2].trim();
      const labelText = label && !localTarget(label, vault) ? label : (j.name ?? basename(abs));
      let rep;
      if (m[1] === '!') { rep = j.ok ? '' : labelText; if (j.ok) removedImage = true; } else rep = labelText;
      out += part.text.slice(at, m.index) + rep; at = m.index + m[0].length;
    }
    part.text = out + part.text.slice(at);
  }
  let body = parts.map((x) => x.text).join('');
  if (removedImage) body = body.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim(); // 지운 그림 자리의 빈 줄 정리(줄 단위 — 정규식 되돌아가기 없음)
  // 2) 본문 속 평문 상대 참조(files/a.pdf 등, 기존 규칙) — 본문은 그대로 두고 같은 경계 판정으로 붙인다
  for (const ref of extractFileRefs(body, { max })) await take(join(vault, ref));
  if (!body.trim()) body = files.map((f) => f.name).join('\n') || pick('(첨부)', '(attachment)', lang); // DB 제약 btrim(body) ≥ 1
  return { body, files, fails: fails.map(({ name, reason }) => ({ name, reason })) };
}

/** 계획한 파일 읽기 — 같은 경계를 다시 판정하고(계획 뒤 바꿔치기 방어) 마지막 조각은 심링크를 따라가지 않는다. 실패는 roomSafe 사유.
    io — 시험용 주입(기본은 node:fs/promises). 바꿔치기 방어(분리 검수 L-6): 예전에는 realpath → open → stat(경로)였는데,
    open과 stat이 같은 중간 폴더 심링크를 따라가 둘 다 밖 파일을 보고 통과했다. 지금은 **연 뒤에** 경로를 다시 풀어 그대로인지 보고
    (바꿔치기를 유지하면 구역 밖으로 풀린다) 그 경로의 inode를 연 fd의 fstat와 대조한다(열자마자 되돌려도 fd는 밖 파일이라 다르다).
    남는 틈: 연 뒤 되돌림 → 다시 풀기 → 다시 바꿔치기 → stat을 마이크로초 안에 맞추는 경합. 노드에 openat·fd 경로 조회가 없어 이 이상은 비용이 크다. */
export async function readReplyFile(wsId, file, lang = 'ko', io = { open, realpath, stat }) {
  const roots = await zoneRoots(paths(wsId).vault);
  const fail = (kind) => Object.assign(new Error(reasonText(kind, lang)), { roomSafe: true });
  const resolveIn = async () => {
    const real = await io.realpath(file.abs).catch((e) => { throw e?.code === 'ENOENT' ? fail('missing') : fail('outside'); });
    if (real !== file.abs || !inZone(real, roots) || !ATTACH_EXT.test(basename(real))) throw fail('outside');
    return real;
  };
  const real = await resolveIn();
  const fh = await io.open(real, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0)).catch((e) => { throw e?.code === 'ENOENT' ? fail('missing') : fail('outside'); });
  try {
    const st = await fh.stat();
    await resolveIn(); // 연 뒤 경로가 그대로인가
    const again = await io.stat(real).catch(() => null);
    if (!st.isFile() || !again || again.ino !== st.ino || again.dev !== st.dev) throw fail('outside');
    if (st.nlink > 1) throw fail('hardlink');
    if (st.size > ATTACH_MAX) throw fail('big');
    const buf = await fh.readFile();
    if (buf.length > ATTACH_MAX) throw fail('big');
    return buf;
  } finally { await fh.close().catch(() => {}); }
}
