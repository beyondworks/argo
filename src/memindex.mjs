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
import { paths, WS_ROOT } from './workspace.mjs';
import { docMeta } from './vaultdoc.mjs';
import { withLock } from './mutex.mjs';

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
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/** 경합(잠금)인가 손상인가. 경합은 정상 상태다 — 이걸 손상으로 오인해 DB를 지우면 다음 턴이
    전 문서 재구축을 물고, 재구축이 락을 더 오래 쥐어 충돌을 부른다(검수 HIGH: 45턴 중 14턴 삭제). */
const isBusy = (e) => /database is locked|busy/i.test(String(e?.message ?? e));

function open(wsId) {
  const p = paths(wsId);
  const file = join(p.root, '.index.sqlite');
  // busy timeout은 일부러 0(기본값)이다. DatabaseSync는 동기 API라 busy 대기가 스레드를 통째로
  // 세우는데, 락을 쥔 쪽은 await(readdir·stat·readFile)로 진행해야 하고 그 진행에 필요한 이벤트
  // 루프를 대기자가 막는다 — 같은 프로세스에서 턴 2개가 겹치면 자기 자신과의 데드락으로 타임아웃
  // 만료가 보장된다(검수 CRITICAL: 5초 전면 정지 실측, HTTP·게이트웨이·스케줄러까지 동반 정지).
  // 같은 프로세스 경합은 withLock이 원천 차단하고, 다른 프로세스와의 경합은 즉시 실패 → 정본
  // 폴백이 맞다 — 기다리는 것 자체가 이 캐시가 없애려는 지연보다 크다.
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
  // 읽기 동시성은 stat과 분리해 훨씬 낮게 잡는다: stat은 fd를 오래 쥐지 않지만 readFile은 쥔다.
  // 512로 같이 뒀다가 최초 구축(전 파일이 stale)에서 EMFILE로 문서가 조용히 누락됐다
  // — ulimit -n 256에서 1500개 중 723개만 인덱싱(검수 CRITICAL). 실패를 삼키면 "부분 인덱스"와
  // "정상 인덱스"가 구분 불가라, 아래에서 실패 수를 세어 호출자가 알 수 있게 한다.
  const STAT_BATCH = 512;
  const READ_BATCH = 24;
  let readFailed = 0;
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
      // 바뀐 것만 읽는다. 평상시엔 0~1개라 이 루프는 비어 있다(최초 구축에서만 전량).
      for (let j = 0; j < stale.length; j += READ_BATCH) {
        const chunk = stale.slice(j, j + READ_BATCH);
        const texts = await Promise.all(chunk.map((s) => readFile(s.file, 'utf8').catch(() => null)));
        for (let k = 0; k < chunk.length; k++) {
          if (texts[k] === null) { readFailed++; continue; }
          const s = chunk[k];
          const m = docMeta(s.rel, texts[k], s.mtimeMs);
          upsert.run(s.rel, m.kind, m.title, JSON.stringify(m.links), m.stamp.date, m.stamp.exact ? 1 : 0, s.mtimeMs, s.size);
        }
      }
    }
  }
  const del = db.prepare('DELETE FROM docs WHERE rel = ?');
  for (const rel of known.keys()) if (!seen.has(rel)) del.run(rel); // 사라진 문서 정리
  return { readFailed };
}

/** 인덱스 렌더링용 문서 메타 전체. 캐시를 쓸 수 없으면 null — 호출자가 정본 전수 읽기로 폴백한다.
    반환 형태는 정본 경로(vaultDocsMeta)와 동일해야 한다. 갈리면 캐시가 거짓말을 하게 된다. */
let warnedUnavailable = false;
export async function loadDocsMeta(wsId) {
  if (!sqliteAvailable()) {
    if (!warnedUnavailable) { // 조용히 느려지는 것보다 한 줄 남기는 게 낫다(Node 22.5 미만 등)
      warnedUnavailable = true;
      console.warn('[memindex] 기억 인덱스 캐시를 쓸 수 없습니다 — 매 턴 vault 전수 읽기로 동작합니다(node:sqlite 없음 또는 ARGO_MEMINDEX=0).');
    }
    return null;
  }
  // 같은 프로세스의 동시 턴(웹+텔레그램 — mutex.mjs가 기정사실로 문서화)을 wsId 단위로 직렬화한다.
  // 이게 없으면 두 턴이 같은 DB를 경쟁하고, 동기 API 특성상 대기 = 이벤트 루프 정지다(open() 주석).
  return withLock(`memindex:${wsId}`, () => loadDocsMetaLocked(wsId));
}

async function loadDocsMetaLocked(wsId) {
  let handle;
  let busy = false;
  let failed = false;
  try {
    handle = open(wsId);
    // 단일 트랜잭션 — autocommit이면 upsert마다 커밋한다(10만 행 7,204ms → 185ms, 검수 실측 39배).
    // 쓰기 락 보유 창이 같이 줄어 다른 프로세스와의 경합 확률도 떨어진다.
    handle.db.exec('BEGIN IMMEDIATE');
    let stats;
    try { stats = await refresh(handle.db, wsId); handle.db.exec('COMMIT'); } catch (e) { handle.db.exec('ROLLBACK'); throw e; }
    if (stats.readFailed) { // 부분 인덱스를 정상으로 위장하지 않는다 — 다음 스캔에서 다시 시도된다
      console.warn(`[memindex] 문서 ${stats.readFailed}개를 읽지 못해 인덱스에서 빠졌습니다(fd 부족·권한 등). 다음 갱신에서 재시도합니다.`);
    }
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
    failed = true;
    busy = isBusy(e); // 경합은 손상이 아니다 — 이번 턴만 정본 경로로 가고 캐시는 그대로 둔다
    if (!busy) console.warn(`[memindex] 캐시를 버리고 재구축합니다: ${e?.message ?? e}`);
    return null;
  } finally {
    try { handle?.db.close(); } catch { /* 이미 닫힘 */ }
    // 손상일 때만 지운다. close 먼저, 그다음 unlink — Windows SQLite VFS는 열린 핸들의 삭제를
    // 거부한다(검수 MEDIUM, 추정). 열기 자체가 실패했으면 handle이 없으므로 경로로 지운다.
    if (failed && !busy) {
      try { await unlink(handle?.file ?? join(paths(wsId).root, '.index.sqlite')); } catch { /* 치명적이지 않다 */ }
    }
  }
}

/** 링크만 덧붙이는 쓰기처럼 **mtime이 보존되는 변경**을 캐시에 알린다.
    캐시의 변경 판정 키가 mtime+size라, mtime이 그대로이고 크기까지 우연히 같으면 변경을 영영 못 본다.
    appendLink는 append가 아니라 링크 섹션 전체 재조립이라 중복 링크 제거·공백 정규화로 크기가 줄 수도
    있고, 늘어난 만큼과 상쇄되면 정확히 같아진다(검수 HIGH — 실제로 재현됨). 해당 행을 지워 다음
    스캔이 반드시 다시 읽게 한다. 실패해도 치명적이지 않다(다음 내용 변경에서 회복). */
export async function invalidatePath(absFile) {
  if (!sqliteAvailable()) return;
  const rel = relative(WS_ROOT, absFile).split(sep).join('/');
  const wsId = rel.split('/')[0];
  if (!wsId || rel.startsWith('..')) return; // 워크스페이스 밖 — 캐시와 무관
  // loadDocsMeta와 같은 락 — 같은 프로세스에서 인덱스 갱신과 겹쳐 BUSY로 조용히 무산되는 것을 막는다
  await withLock(`memindex:${wsId}`, () => {
    let handle;
    try {
      handle = open(wsId);
      const docRel = relative(paths(wsId).vault, absFile).split(sep).join('/');
      handle.db.prepare('DELETE FROM docs WHERE rel = ?').run(docRel);
    } catch { /* 캐시 무효화 실패는 치명적이지 않다 — 다음 내용 변경에서 회복 */ } finally {
      try { handle?.db.close(); } catch { /* 이미 닫힘 */ }
    }
  });
}
