// 회사 기억 인덱스 캐시 — 정본은 vault의 md 파일이고 이건 언제든 버리고 재구축하는 캐시다.
//
// 왜: saveHandover가 턴마다 updateIndex를 부르고, 그게 vault의 모든 md를 전문 읽었다. 문서 수에
// 비례해 턴이 느려진다 — 기억이 쌓일수록 제품이 느려지는 역인센티브다(설계 docs/memory-store-design.md).
// 여기서는 readdir+stat만 하고, mtime·size가 바뀐 파일만 다시 읽는다.
//
// 3원칙(어기면 캐시가 아니라 두 번째 정본이 된다):
//  1) 스키마가 코드와 어긋나면 마이그레이션하지 않고 통째로 버리고 재구축한다.
//  2) 열기·읽기 실패는 치명적이지 않다 — null을 돌려 호출자가 정본 전수 읽기로 폴백한다.
//  3) DB 파일은 동기화 대상이 아니다(sync.mjs EXCLUDE). 기기마다 자기 캐시를 갖는다.
import { readdir, stat, readFile, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { paths } from './workspace.mjs';
import { docMeta } from './vaultdoc.mjs';

const SCHEMA_VERSION = '1';
const require = createRequire(import.meta.url); // 동적 import는 동기 기능 탐지에 못 쓴다

// node:sqlite는 Node 22.5+ 내장(실험적). 없는 런타임에서도 제품이 그대로 돌아야 하므로 기능 탐지한다.
let sqliteMod;
export function sqliteAvailable() {
  if (process.env.ARGO_MEMINDEX === '0') return false; // 킬 스위치 — 캐시를 의심할 때 정본 경로로 되돌린다
  if (sqliteMod === undefined) {
    try { sqliteMod = require('node:sqlite'); } catch { sqliteMod = null; }
  }
  return !!sqliteMod;
}

const DDL = `
CREATE TABLE IF NOT EXISTS docs (
  rel        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  links      TEXT NOT NULL,          -- JSON 배열(순서·중복 그대로 — 인덱스 출력이 바뀌면 안 된다)
  updated    TEXT NOT NULL,
  updated_exact INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  size       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function open(wsId) {
  const p = paths(wsId);
  const file = join(p.root, '.index.sqlite');
  const db = new sqliteMod.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(DDL);
  const ver = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()?.v;
  if (ver !== SCHEMA_VERSION) { // 마이그레이션하지 않는다 — 캐시라서 버리는 게 맞고, 그래야 캐시로 남는다
    db.exec('DROP TABLE IF EXISTS docs');
    db.exec(DDL);
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  }
  return { db, file };
}

/** 디스크를 훑어 캐시를 최신화한다. 읽는 건 mtime·size가 달라진 파일뿐.
    변경 판정 키로 해시 대신 mtime+size를 쓴다 — 해시를 쓰려면 전수 읽기가 필요해 목적과 모순된다.
    (내용이 바뀌었는데 mtime·size가 동시에 같은 경우는 놓친다. 링크 append는 size가 늘고, 동기화
    수신은 원격 mtime을 심으므로 실제 경로에선 발생하지 않는다.) */
async function refresh(db, wsId) {
  const p = paths(wsId);
  const known = new Map();
  for (const r of db.prepare('SELECT rel, mtime_ms, size FROM docs').all()) {
    known.set(r.rel, { mtimeMs: r.mtime_ms, size: r.size });
  }
  const seen = new Set();
  const upsert = db.prepare(
    `INSERT INTO docs (rel, kind, title, links, updated, updated_exact, mtime_ms, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rel) DO UPDATE SET
       kind=excluded.kind, title=excluded.title, links=excluded.links,
       updated=excluded.updated, updated_exact=excluded.updated_exact,
       mtime_ms=excluded.mtime_ms, size=excluded.size`);

  // stat은 병렬로 — 이게 스캔 비용의 지배 항목이다. 문서 10만에서 직렬 1275ms → 병렬 363ms(실측).
  // 한 번에 다 띄우지 않고 배치로 끊는다(파일 디스크립터 고갈 방지).
  const STAT_BATCH = 512;
  for (const dir of [p.journal, p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    names = names.filter((n) => n.endsWith('.md'));
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      const slice = names.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(slice.map((n) => stat(join(dir, n)).catch(() => null)));
      const stale = [];
      for (let k = 0; k < slice.length; k++) {
        const st = stats[k];
        if (!st?.isFile()) continue;
        const file = join(dir, slice[k]);
        // rel은 논리 경로('/' 고정) — Windows relative()의 백슬래시가 notes/·journal/ 판정을 깨지 않게
        const rel = relative(p.vault, file).split(sep).join('/');
        seen.add(rel);
        const prev = known.get(rel);
        const mtimeMs = Math.round(st.mtimeMs);
        if (prev && prev.mtimeMs === mtimeMs && prev.size === st.size) continue; // 안 바뀜 — 읽지 않는다
        stale.push({ file, rel, mtimeMs, size: st.size });
      }
      // 바뀐 것만 읽는다. 평상시엔 0~1개라 이 루프는 비어 있다.
      const texts = await Promise.all(stale.map((s) => readFile(s.file, 'utf8').catch(() => null)));
      for (let k = 0; k < stale.length; k++) {
        if (texts[k] === null) continue;
        const s = stale[k];
        const m = docMeta(s.rel, texts[k], s.mtimeMs);
        upsert.run(s.rel, m.kind, m.title, JSON.stringify(m.links), m.stamp.date, m.stamp.exact ? 1 : 0, s.mtimeMs, s.size);
      }
    }
  }
  const del = db.prepare('DELETE FROM docs WHERE rel = ?');
  for (const rel of known.keys()) if (!seen.has(rel)) del.run(rel); // 사라진 문서 정리
}

/** 인덱스 렌더링용 문서 메타 전체. 캐시를 쓸 수 없으면 null — 호출자가 정본 전수 읽기로 폴백한다.
    반환 형태는 정본 경로(vaultDocsMeta)와 동일해야 한다. 갈리면 캐시가 거짓말을 하게 된다. */
export async function loadDocsMeta(wsId) {
  if (!sqliteAvailable()) return null;
  let handle;
  try {
    handle = open(wsId);
    await refresh(handle.db, wsId);
    const rows = handle.db.prepare('SELECT * FROM docs').all();
    return rows.map((r) => ({
      rel: r.rel,
      kind: r.kind,
      title: r.title,
      links: JSON.parse(r.links),
      stamp: { date: r.updated, exact: !!r.updated_exact },
      mtimeMs: r.mtime_ms,
    }));
  } catch (e) {
    // 손상·잠금·권한 — 캐시는 없어도 되는 것이다. 지우고 다음 기회에 다시 만든다.
    try { await unlink(join(paths(wsId).root, '.index.sqlite')); } catch { /* 지우기 실패도 치명적이지 않다 */ }
    return null;
  } finally {
    try { handle?.db.close(); } catch { /* 이미 닫힘 */ }
  }
}
