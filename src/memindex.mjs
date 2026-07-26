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

// 같은 파일 경고 반복 방지 — 영구적으로 못 읽는 파일 1개가 턴마다 로그를 쌓으면 진짜 신호가 묻힌다.
// 읽기에 성공하면 지워서, 회복 후 재발 시 다시 경고한다.
const warnedReadFail = new Set();

/** 디스크를 훑어 캐시를 최신화한다. 읽는 건 mtime·size가 달라진 파일뿐.
    변경 판정 키로 해시 대신 mtime+size를 쓴다 — 해시를 쓰려면 전수 읽기가 필요해 목적과 모순된다.
    ⚠ 내용이 바뀌었는데 mtime·size가 동시에 같은 경우는 이 판정으로 못 잡는다 — 실제로 발생한다
    (2라운드 검수 재현: appendLink는 append가 아니라 링크 섹션 재조립이라 중복 제거·공백 정규화로
    줄어든 크기가 새 링크와 상쇄될 수 있다). 그래서 mtime을 심는 쓰기 경로가 명시적으로 캐시를
    무효화한다: writeKeepingMtime(memory.mjs)·동기화 수신 writeLocal(sync.mjs) → invalidatePath.

    구조: [스캔 — 락 없음, await 포함] → [쓰기 — 동기 트랜잭션만]. 트랜잭션을 스캔 전체에 걸치면
    무변경 턴조차 stat 스윕 내내 배타 락을 쥔다(검수 실측: 무변경 195ms 중 167ms 타 연결 획득 실패).
    쓰기 단계는 await가 없어 락 보유 창이 순수 CPU 시간뿐이다. */
async function refresh(db, wsId) {
  const p = paths(wsId);
  const known = new Map();
  for (const r of db.prepare('SELECT rel, mtime_ms, size FROM docs').all()) {
    known.set(r.rel, { mtimeMs: r.mtime_ms, size: r.size });
  }
  const seen = new Set();
  const pendingUpsert = [];
  const pendingDelete = [];
  // 폴더 → 논리 접두 매핑 — readdir 실패를 "빈 폴더"로 오인하면 그 폴더의 전 행이 삭제 대상이 된다
  const DIR_PREFIX = new Map([[p.journal, 'journal/'], [p.conversations, 'conversations/'], [p.notes, 'notes/']]);

  // stat은 병렬로 — 이게 스캔 비용의 지배 항목이다. 문서 10만에서 직렬 1275ms → 병렬 363ms(실측).
  // 읽기 동시성은 stat과 분리해 훨씬 낮게 잡는다: stat은 fd를 오래 쥐지 않지만 readFile은 쥔다.
  // 512로 같이 뒀다가 최초 구축(전 파일이 stale)에서 EMFILE로 문서가 조용히 누락됐다
  // — ulimit -n 256에서 1500개 중 723개만 인덱싱(검수 CRITICAL).
  const STAT_BATCH = 512;
  const READ_BATCH = 24;
  let readFailed = 0;
  for (const dir of [p.journal, p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch (e) {
      // 없는 폴더(ENOENT)는 장애가 아니라 정당한 삭제다 — 기존대로 건너뛰어 not-seen 경로가 죽은
      // 행을 정리하게 둔다. 이걸 장애로 오인하면 known에 행이 남는 한 매 턴 unhealthy → 그 회사의
      // 캐시가 영구 무력화된다(3라운드 재검수 G1: conversations/ 폴더를 지운 회사에서 재현 — 이
      // PR이 없애려던 턴당 전수 읽기가 조용히 영구 복귀).
      if (e?.code === 'ENOENT') continue;
      // 행이 있던 폴더가 존재하는데 안 읽히면(EACCES 등 권한·마운트) 삭제가 아니라 장애다 — 이번
      // 스캔을 불건전으로 판정해 캐시를 건드리지 않고 물러난다(3라운드 검수 F3: 폴더 chmod 000에서
      // 행 6→1 침묵 정리 + 경고 0 재현). 행이 없던 폴더는 기존대로 건너뛴다.
      const prefix = DIR_PREFIX.get(dir);
      for (const rel of known.keys()) {
        if (rel.startsWith(prefix)) return { unhealthy: `${prefix} 폴더를 읽지 못했습니다(권한·마운트 확인)` };
      }
      continue;
    }
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
        // ⚠ 알려진 한계(3라운드 검수, 문서화된 잔여): 내용·mtime·size가 전부 그대로인 채 "읽기 권한만"
        // 잃은 파일은 여기서 걸러져 옛 행이 남는다 — 정본 폴백은 읽기를 시도해 빼므로 이 실패 모드에선
        // 두 경로가 갈린다. 감지하려면 매 스캔 파일마다 access() 왕복이 추가돼(스캔 비용 ~2배) 수용 안 함.
        if (prev && prev.mtimeMs === mtimeMs && prev.size === st.size) continue; // 안 바뀜 — 읽지 않는다
        stale.push({ file, rel, mtimeMs, size: st.size });
      }
      // 바뀐 것만 읽는다. 평상시엔 0~1개라 이 루프는 비어 있다(최초 구축에서만 전량).
      for (let j = 0; j < stale.length; j += READ_BATCH) {
        const chunk = stale.slice(j, j + READ_BATCH);
        const texts = await Promise.all(chunk.map((s) => readFile(s.file, 'utf8').catch(() => null)));
        for (let k = 0; k < chunk.length; k++) {
          const s = chunk[k];
          if (texts[k] === null) {
            // 읽을 수 없는 문서는 인덱스에서 뺀다 — 정본 폴백도 같은 입력에서 빼므로 두 경로가
            // 일치한다(검수 HIGH: 캐시만 옛 값을 계속 보여줘 산출물이 갈렸다). 크루도 못 읽을
            // 파일을 실어두는 건 거짓 약속이다. 행이 없으니 다음 스캔이 자동 재시도한다.
            readFailed++;
            pendingDelete.push(s.rel);
            const warnKey = `${wsId}:${s.rel}`; // wsId 포함 — 회사 A의 실패가 회사 B의 같은 rel 경고를 침묵시키지 않게
            if (!warnedReadFail.has(warnKey)) {
              warnedReadFail.add(warnKey);
              console.warn(`[memindex] 문서를 읽지 못해 인덱스에서 뺍니다(권한·fd 부족 등, 회복 시 자동 복귀): ${wsId}/${s.rel}`);
            }
            continue;
          }
          warnedReadFail.delete(`${wsId}:${s.rel}`);
          const m = docMeta(s.rel, texts[k], s.mtimeMs);
          pendingUpsert.push([s.rel, m.kind, m.title, JSON.stringify(m.links), m.stamp.date, m.stamp.exact ? 1 : 0, s.mtimeMs, s.size]);
        }
      }
    }
  }
  for (const rel of known.keys()) if (!seen.has(rel)) pendingDelete.push(rel); // 사라진 문서 정리

  // 대량 읽기 실패 퓨즈 — 한두 개는 개별 파일 문제(HIGH-4 정책대로 뺀다)지만, 수십 개가 한 턴에
  // 실패하면 파일이 아니라 환경(fd 고갈·마운트)이 아픈 것이다. 그 판단으로 행을 쓸어내면 회복 후
  // 전량 재구축(10만 문서 기준 11~13초)을 다시 문다. 이번 턴은 캐시를 건드리지 않고 물러난다.
  // 진짜 대량 삭제(파일이 실제로 없어진 것)는 readdir·stat이 성공한 not-seen 경로라 퓨즈에 안 걸린다.
  if (readFailed > 20) return { unhealthy: `문서 ${readFailed}개 읽기 실패 — 일시 장애로 판단해 캐시를 보존합니다` };

  // 쓰기 단계 — 변경이 있을 때만, 동기 구간만 트랜잭션. autocommit이면 행마다 커밋한다
  // (검수 실측 10만 행 7,204ms → 185ms). 무변경 턴은 쓰기문 자체가 없어 락을 전혀 잡지 않는다.
  if (pendingUpsert.length || pendingDelete.length) {
    const upsert = db.prepare(
      `INSERT INTO docs (rel, kind, title, links, updated, updated_exact, mtime_ms, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(rel) DO UPDATE SET
         kind=excluded.kind, title=excluded.title, links=excluded.links,
         updated=excluded.updated, updated_exact=excluded.updated_exact,
         mtime_ms=excluded.mtime_ms, size=excluded.size`);
    const del = db.prepare('DELETE FROM docs WHERE rel = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of pendingUpsert) upsert.run(...row);
      for (const rel of pendingDelete) del.run(rel);
      db.exec('COMMIT');
    } catch (e) {
      // ROLLBACK 자체가 던지면(자동 롤백된 상태 등) 원인 예외가 대체되어 BUSY가 손상으로
      // 오분류된다(검수 MEDIUM) — 삼키고 원인을 올린다.
      try { db.exec('ROLLBACK'); } catch { /* 이미 롤백됨 */ }
      throw e;
    }
  }
  return { readFailed };
}

/** 인덱스 렌더링용 문서 메타 전체. 캐시를 쓸 수 없으면 null — 호출자가 정본 전수 읽기로 폴백한다.
    반환 형태는 정본 경로(vaultDocsMeta)와 동일해야 한다. 갈리면 캐시가 거짓말을 하게 된다. */
let warnedUnavailable = false;
const warnedUnhealthy = new Set(); // 같은 장애가 턴마다 로그를 쌓지 않게 — 건강해지면 리셋
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
    // 트랜잭션은 refresh 내부의 쓰기 단계에만 있다 — 스캔(await 구간)에 걸치면 무변경 턴조차
    // 배타 락을 스윕 내내 쥔다(검수 HIGH). 경고도 refresh가 rel 단위로 1회만 낸다.
    const scan = await refresh(handle.db, wsId);
    if (scan?.unhealthy) {
      // 스캔이 온전하지 않다 — 손상도 경합도 아니므로 지우지도, 쓰지도 않는다. 이번 턴만 정본 폴백.
      // (폴백도 같은 장애를 겪으면 같은 산출물을 낸다 — 실패 모드에서도 두 경로 동등성이 유지된다)
      const key = `${wsId}:${scan.unhealthy}`;
      if (!warnedUnhealthy.has(key)) {
        warnedUnhealthy.add(key);
        console.warn(`[memindex] 이번 턴은 캐시를 건너뜁니다(행 보존): ${scan.unhealthy}`);
      }
      return null;
    }
    // 건강한 스캔 — 이 회사의 장애 경고만 리셋한다. 전체 clear면 회사 A의 건강이 회사 B의 경고를
    // 지운다(3라운드 재검수 LOW — F7에서 고친 것과 같은 계열의 역방향 실수).
    for (const k of warnedUnhealthy) if (k.startsWith(`${wsId}:`)) warnedUnhealthy.delete(k);
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
    } catch { /* 크로스 프로세스 경합 등으로 무산될 수 있다 — 조용히 넘기는 근거: 같은 데이터 루트에
      프로세스 둘이 같은 노트를 동시에 만지는 경우 자체가 드물고, 놓쳐도 다음 내용 변경(mtime·size
      변동)에서 자가 회복된다. ("pidfile이 동시 기동을 막는다"던 이전 근거는 사실이 아니라 철회 —
      sync의 holdSyncLock은 동기화 사이클만 건너뛰게 하고 턴은 계속 돈다. 3라운드 검수 확인) */ } finally {
      try { handle?.db.close(); } catch { /* 이미 닫힘 */ }
    }
  });
}
