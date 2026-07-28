// 옵시디언 볼트 임포트 — 외부 볼트를 Argo 스캐폴드(journal·notes·files)로 증류 복사한다.
// 설계 정본: docs/obsidian-import-design.md. 제품 원칙: "옵시디언 임포트 = Argo 스캐폴드 재분류".
//
// 불변 원칙:
//  - 원본 볼트는 읽기 전용 — 소스에 단 1바이트도 쓰지 않는다(임포트 = 복사).
//  - 기존 회사 데이터를 덮지 않는다 — 대상 충돌은 폴더 접두 → 접미 번호로 분리(기억 유실 금지).
//  - 증류 불가는 버리지 않는다 — vault/_imported/unsorted/에 보존하고 건별 이유를 리포트에 싣는다.
//  - 러너 없이 완결 — 규칙 기반만으로 끝난다(LLM 증류는 Phase 2).
//  - 서버 한국어 하드코딩 금지(K7 계열) — 오류·이유는 코드로, UI가 i18n 매핑.
//    리포트 md 파일만 회사 언어(company.json lang)를 따른다(크루 기억 노트와 같은 규약).
//  - 들여오는 방향의 시크릿 계약(분리 검수 CRITICAL-1/HIGH-1 2026-07-28): 임포트는 읽은 것을
//    회사 vault(동기화·크루 열람·내보내기 대상)로 싣는 행위다. export가 "자격을 내보내지 않는다"면
//    임포트는 "자격을 들여오지 않는다"가 대칭 계약이다 — ① 소스가 Argo 데이터 루트(WS_ROOT·~/.argo)를
//    포함하는 조상이면 거부(타 회사 통째 흡입 차단 — workroots의 조상 허용 예외를 상속하지 않는다),
//    ② Argo 제어파일 basename(connections.json 등)은 어느 볼트에서든 복사하지 않는다.
//
// 규모(관문 0.5): 사용자 1회성 액션 — 상시 타이머 없음. 비용은 볼트 크기에 선형(복사 1회 +
// 이후 동기화 1회 업로드). 상한: 파일 2,000·합계 2GB — 수치 근거는 임포트 자체가 아니라
// **임포트 이후의 상시 비용**이다: listDocs(hub.mjs)가 무캐시로 notes·journal 전 파일을 매 화면
// 로드마다 읽으므로, 노트 수가 곧 대시보드 로드 비용이 된다(분리 검수 HIGH-2). listDocs의
// memindex 캐시 전환이 후속 백로그(설계 문서 참조)이고, 그때 상한을 올린다.
import { readdir, readFile, copyFile, mkdir, stat, utimes, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { paths, loadCompany, WS_ROOT } from './workspace.mjs';
import { validateWorkRoot } from './workroots.mjs';
import { updateIndex } from './memory.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { insideFold, fold } from './pathcase.mjs';

const err = (code, msg) => Object.assign(new Error(msg), { code });

export const MAX_FILE_BYTES = 200 * 1024 * 1024;      // 단일 파일 상한 — 초과는 복사 없이 리포트(원본은 볼트에 그대로)
export const MAX_COUNT = 2_000;                        // 총 파일 수 상한 — listDocs 상시 비용 근거(모듈 주석)
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 총 용량 상한 — 동기화 1회 업로드 비용

// Argo files/ 서빙(files/route.js MIME)과 옵시디언 통용 첨부의 교집합 위주 — 여기 없으면 미분류로
// 정직하게 보낸다(조용히 버리지 않는다).
const ATTACH_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'zip', 'pptx', 'docx', 'xlsx', 'csv', 'txt', 'json', 'html']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const DAILY_RE = /^(\d{4}-\d{2}-\d{2})(.*)\.md$/i;     // 옵시디언 Daily Notes 기본 형식(+ 뒤 수식어 허용)
const TEMPLATE_SEG = /^_?templates?$|^템플릿$/i;
// Argo 제어파일 — 어느 소스에서든 들여오지 않는다(회사 흡입·오조작 대비 심층 방어, 검수 HIGH-1).
// 직속 도트파일(.secrets.json 등)은 도트 규칙이 이미 걸러 별도 등재 불요.
const SENSITIVE_BASE = new Set(['connections.json', 'mcp.json', 'company.json', 'capabilities.json']);

/** 경로 조각 정리 — 위키링크 문법 문자·경로 위험 문자 제거, 공백→'-'. 케이스·한글은 보존.
    (export: 회귀 테스트용) */
export function sanitizeSegment(name) {
  const s = String(name)
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 80);
  return s || 'untitled';
}

/** 분류 규칙(순수) — rel = 소스 볼트 기준 '/' 상대경로. 설계 문서의 표와 1:1.
    빈 md 판정은 내용을 읽는 시점(플랜 단계)에 별도로 한다. (export: 회귀 테스트용) */
export function classifyVaultEntry(rel, size = 0) {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  if (segs.some((s) => s.startsWith('.'))) return { dest: 'skip', reason: 'config' };
  if (SENSITIVE_BASE.has(base)) return { dest: 'skip', reason: 'sensitive' }; // 복사 안 함 — 원본은 소스에 그대로
  if (segs.slice(0, -1).some((s) => TEMPLATE_SEG.test(s))) return { dest: 'unsorted', reason: 'template' };
  if (size > MAX_FILE_BYTES) return { dest: 'skip', reason: 'too-large' };
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (ext === 'md') return DAILY_RE.test(base) ? { dest: 'journal', reason: null } : { dest: 'notes', reason: null };
  if (ATTACH_EXT.has(ext)) return { dest: 'files', reason: null };
  return { dest: 'unsorted', reason: 'unknown-type' };
}

/** 위키링크 재작성(순수) — 임포트되는 md에만 적용. noteMap: 소문자 타깃 키 → 새 rel(확장자 없음).
    attMap: 소문자 첨부 키 → files/ 상대 rel(확장자 포함). 맵에 없는 타깃은 원문 그대로 보존.
    #섹션·|별칭은 Argo 렌더러(ui.jsx Markdown → rel.md 열기)가 지원하지 않아 남기면 링크가 죽는다 —
    기능 보존이 표기 보존보다 우선(설계 문서 근거). (export: 회귀 테스트용) */
export function rewriteLinks(content, { noteMap, attMap, wsId }) {
  return content.replace(/(!?)\[\[([^\][]+)\]\]/g, (whole, bang, inner) => {
    const target = inner.split('|')[0].split('#')[0].trim();
    if (!target) return whole;
    const keyFull = target.toLowerCase().replace(/\.md$/i, '');
    const keyBase = keyFull.split('/').pop();
    const note = noteMap.get(keyFull) ?? noteMap.get(keyBase);
    if (note) return `[[${note}]]`;
    // 첨부 임베드/링크 — files 서빙 URL로. 이미지는 인라인 렌더(Markdown 이미지 필터가 동일출처 '/'만 허용).
    const attKeyFull = target.toLowerCase();
    const att = attMap.get(attKeyFull) ?? attMap.get(attKeyFull.split('/').pop());
    if (att) {
      // 괄호는 md 링크 문법을 깬다 — encodeURIComponent가 ()를 안 바꾸므로 직접 인코딩(검수 LOW-1)
      const url = `/api/companies/${wsId}/files?rel=${encodeURIComponent(att).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;
      const label = basename(target).replace(/[[\]()]/g, ' ').trim();
      return bang && IMG_EXT.has(att.split('.').pop().toLowerCase()) ? `![${label}](${url})` : `[${label}](${url})`;
    }
    return whole; // 미임포트·외부 타깃 — 임의 추측 재작성 금지
  });
}

/* ── 진행 상태 — 직속 도트파일 + '.status.json' 접미: sync EXCLUDE의 상태 파일 규칙
   (sync.mjs: base.endsWith('.status.json'))과 export의 직속 도트 제외에 둘 다 걸린다.
   (첫 이름 '.import-status.json'은 접미 불일치로 동기화를 탔다 — 분리 검수 MED-2 실측) */
const statusFile = (wsId) => join(paths(wsId).root, '.import.status.json');

export async function readImportStatus(wsId) {
  return readJsonLenient(statusFile(wsId), { phase: 'idle' });
}

async function writeStatus(wsId, status) {
  await writeJsonAtomic(statusFile(wsId), { ...status, at: new Date().toISOString() }).catch(() => {});
}

/* ── 재실행 대장(manifest) — 소스 파일 → 배치된 타깃. 같은 볼트를 다시 가져오면 변화분만 추가되고
   (미변경 = already-imported), 링크 맵은 기존 타깃을 재사용한다. 소스가 바뀐 파일은 덮지 않고
   새 사본(접미 번호)으로 들어간다 — 기억 유실 금지.
   알려진 한계(검수 MED-6, 문서화 유보): 키가 소스 절대경로라 볼트를 옮기거나 다른 기기에서
   같은 볼트를 가져오면 새 소스로 취급된다(중복 사본 — 유실은 아님). 볼트 지문 키는 후속. */
const manifestFile = (wsId) => join(paths(wsId).vault, '_imported', 'manifest.json');

async function loadManifest(wsId) {
  const m = await readJsonLenient(manifestFile(wsId), { version: 1, sources: {} });
  return m && typeof m === 'object' && m.sources ? m : { version: 1, sources: {} };
}

/* ── 소스 볼트 스캔 — 읽기 전용. 도트 항목(설정·휴지통)은 개수만 세고 내려가지 않는다. */
async function scanVault(srcDir) {
  const entries = [];
  const skipped = [];
  let configSkipped = 0;
  async function walk(dir, relBase) {
    let names = [];
    try { names = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.name.startsWith('.')) { configSkipped += 1; continue; } // .obsidian/·.trash/·.DS_Store — 통째로
      if (e.isSymbolicLink()) { skipped.push({ rel, reason: 'symlink' }); continue; } // export.mjs와 같은 근거
      if (e.isDirectory()) { await walk(join(dir, e.name), rel); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = await stat(join(dir, e.name)); } catch { continue; } // 스캔 중 삭제 — 조용히 제외
      entries.push({ rel, size: st.size, mtime: st.mtime });
    }
  }
  await walk(srcDir, '');
  return { entries, skipped, configSkipped };
}

/** 디렉터리별 이름 예약기 — 기존 파일은 readdir 1회로 적재(existsSync 루프가 플랜 구간에서
    이벤트 루프를 막던 것 교정 — 검수 LOW-2). 비교는 소문자(맥 APFS 케이스 무시 대비). */
function makeNamePool() {
  const dirs = new Map(); // dir(fold) → Set(name lower)
  return async function reserve(dir, candidates, ext) {
    const key = fold(dir);
    let pool = dirs.get(key);
    if (!pool) {
      pool = new Set((await readdir(dir).catch(() => [])).map((n) => n.toLowerCase()));
      dirs.set(key, pool);
    }
    // 후보(기본 → 폴더 접두)를 먼저 소진하고, 그래도 충돌이면 첫 후보에 접미 번호
    for (const base of candidates) {
      const name = `${base}${ext}`;
      if (!pool.has(name.toLowerCase())) { pool.add(name.toLowerCase()); return name; }
    }
    for (let n = 2; ; n += 1) {
      const name = `${candidates[0]}-${n}${ext}`;
      if (!pool.has(name.toLowerCase())) { pool.add(name.toLowerCase()); return name; }
    }
  };
}

const REASON_LABEL = {
  ko: {
    template: '템플릿(서식) 폴더', empty: '빈 노트', 'unknown-type': 'Argo가 읽을 수 없는 형식',
    'too-large': '200MB 초과 — 복사하지 않음(원본은 볼트에 그대로)', symlink: '심링크(바로가기) — 복사하지 않음',
    sensitive: 'Argo 제어파일과 같은 이름 — 복사하지 않음(원본은 볼트에 그대로)',
    'user-deleted': '이전 임포트에서 가져왔다가 앱에서 삭제한 항목 — 되살리지 않음',
    'ambiguous-link': '같은 이름의 노트가 여러 개 — 링크는 먼저 배치된 쪽으로 연결',
  },
  en: {
    template: 'template folder', empty: 'empty note', 'unknown-type': 'format Argo cannot read',
    'too-large': 'over 200MB — not copied (original stays in your vault)', symlink: 'symlink — not copied',
    sensitive: 'same name as an Argo control file — not copied (original stays in your vault)',
    'user-deleted': 'imported before and deleted in the app — not resurrected',
    'ambiguous-link': 'duplicate note names — links point to the first one placed',
  },
};

/** 옵시디언 볼트 임포트 본체. dryRun=true면 복사 없이 분류 계획만 반환한다. */
export async function importObsidianVault(wsId, srcPath, { dryRun = false } = {}) {
  const p = paths(wsId);
  if (!existsSync(p.company)) throw err('no-company', wsId);
  // 소스 검증 재사용 — 절대경로·존재·디렉토리·루트 전체 거부·보호 구역 "안" 거부·realpath 봉인.
  const src = await validateWorkRoot(srcPath);
  // 조상 거부(검수 CRITICAL-1): validateWorkRoot는 WS_ROOT·~/.argo를 "포함하는" 조상을 의도적으로
  // 허용한다(러너 책상 개방의 기존 한계와 동일 계열). 임포트는 읽은 것을 회사 vault로 복사하므로
  // 같은 예외가 "타 회사 자격·대화를 이 회사로 평문 흡입"이 된다 — 임포트 전용으로 막는다.
  const canon = async (t) => { try { return await realpath(t); } catch { return t; } };
  for (const zone of await Promise.all([WS_ROOT, join(homedir(), '.argo')].map(canon))) {
    if (insideFold(zone, src) || fold(zone) === fold(src)) throw err('protected', src);
  }
  return withLock(`obsidian-import:${wsId}`, () => runImport(wsId, src, { dryRun }));
}

async function runImport(wsId, src, { dryRun }) {
  const p = paths(wsId);
  if (!dryRun) await writeStatus(wsId, { phase: 'scan' });
  const { entries, skipped, configSkipped } = await scanVault(src);

  if (entries.length > MAX_COUNT) throw err('too-many', String(entries.length));
  const totalBytes = entries.reduce((a, e) => a + e.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw err('too-big', String(totalBytes));

  const manifest = await loadManifest(wsId);
  const srcBook = manifest.sources[src] ?? (manifest.sources[src] = {});

  // ── 플랜: 분류 → 대상 이름 배정 → 링크 맵. 쓰기는 아직 없다(드라이런은 여기까지의 집계만 반환).
  //    본문은 여기서 보관하지 않는다 — 빈 노트 판정만 하고 버리고, 쓰기 시점에 다시 읽는다
  //    (2GB 상한 통과분이 힙에 통째로 얹히던 것 교정 — 검수 MED-1. I/O 2배 < 메모리 상수화).
  const reserve = makeNamePool();
  const plan = [];               // { rel, size, mtime, dest, isMd, target(절대), targetRel(워크스페이스 표시용) }
  const unsorted = [];
  const already = [];
  const warnings = [];
  const noteMap = new Map();     // 링크 타깃 키(소문자·확장자 없음) → 새 rel(vault 기준, 확장자 없음)
  const attMap = new Map();      // 첨부 키(소문자·확장자 포함) → files/... rel

  const unsortedRoot = join(p.vault, '_imported', 'unsorted');
  const filesRoot = join(p.files, 'imported');

  const mapNote = (rel, vaultRel) => {
    // 옵시디언 [[링크]]는 파일명 기준 — basename과 폴더 포함 경로 둘 다 키로 건다.
    const keyFull = rel.toLowerCase().replace(/\.md$/i, '');
    const keyBase = keyFull.split('/').pop();
    for (const k of new Set([keyFull, keyBase])) {
      if (noteMap.has(k)) { if (warnings.length < 200) warnings.push({ rel, reason: 'ambiguous-link' }); continue; }
      noteMap.set(k, vaultRel);
    }
  };
  const mapAtt = (rel, filesRel) => {
    const keyFull = rel.toLowerCase();
    for (const k of new Set([keyFull, keyFull.split('/').pop()])) if (!attMap.has(k)) attMap.set(k, filesRel);
  };

  for (const e of entries) {
    const prev = srcBook[e.rel];
    if (prev && prev.size === e.size && prev.mtimeMs === e.mtime.getTime()) {
      if (existsSync(join(p.root, prev.target))) {
        already.push({ rel: e.rel, reason: 'already-imported' });
        // 재실행에서도 기존 타깃으로 링크가 이어지게 맵에 싣는다(vault 기준 rel로 변환)
        if (prev.target.startsWith('vault/') && /\.md$/i.test(prev.target) && !prev.target.startsWith('vault/_imported/')) {
          mapNote(e.rel, prev.target.slice('vault/'.length).replace(/\.md$/i, ''));
        } else if (prev.target.startsWith('vault/files/')) {
          mapAtt(e.rel, prev.target.slice('vault/'.length));
        }
      } else {
        // 타깃 부재 = 사용자가 앱에서 지운 것 — 재복사하면 지운 기억이 부활한다(검수 MED-3,
        // jsonstore '유령 대화 부활'과 같은 계급). 스킵하고 리포트로 안내. 정말 되살리려면
        // 소스 파일을 손대(수정 시각 변경) 변경분으로 만들거나 manifest를 지우면 된다.
        skipped.push({ rel: e.rel, reason: 'user-deleted' });
      }
      continue;
    }
    let { dest, reason } = classifyVaultEntry(e.rel, e.size);
    if (dest === 'journal' || dest === 'notes') {
      const content = await readFile(join(src, e.rel), 'utf8').catch(() => null); // 판정 후 버린다(보관 금지)
      if (content === null) { dest = 'unsorted'; reason = 'unknown-type'; } // utf8로 못 읽는 .md — 미분류로 정직하게
      else if (!content.trim()) { dest = 'unsorted'; reason = 'empty'; }
    }
    const base = basename(e.rel);
    const parentSeg = e.rel.includes('/') ? sanitizeSegment(e.rel.split('/').slice(-2, -1)[0]) : '';
    if (dest === 'journal') {
      const m = base.match(DAILY_RE);
      const rest = m[2] ? sanitizeSegment(m[2]) : '';
      // vaultdoc.docKind의 일지 판정(^\d{4}-\d{2}-\d{2}-)에 맞는 이름 — 인덱스 "최근 일지" 구간에 잡힌다
      const stem = `${m[1]}-${rest && rest !== 'untitled' ? `${rest}-` : ''}imported`;
      const name = await reserve(p.journal, [stem], '.md');
      plan.push({ ...e, dest, isMd: true, target: join(p.journal, name), targetRel: `vault/journal/${name}` });
      mapNote(e.rel, `journal/${name.replace(/\.md$/, '')}`);
    } else if (dest === 'notes') {
      // notes/는 평면이 정본 구조(listDocs 비재귀) — 폴더 경로는 버리고 파일명만.
      // 충돌 시 폴더 접두(`폴더명-파일명`) → 그래도 충돌이면 접미 번호(설계 문서 규칙 — ProjectA/index.md
      // 3벌이 index-2·index-3으로 뭉개져 어느 프로젝트 것인지 알 수 없게 되는 맥락 소실 방지, 검수 MED-4).
      const stem = sanitizeSegment(base.replace(/\.md$/i, ''));
      const candidates = parentSeg && parentSeg !== 'untitled' ? [stem, `${parentSeg}-${stem}`] : [stem];
      const name = await reserve(p.notes, candidates, '.md');
      plan.push({ ...e, dest, isMd: true, target: join(p.notes, name), targetRel: `vault/notes/${name}` });
      mapNote(e.rel, `notes/${name.replace(/\.md$/, '')}`);
    } else if (dest === 'files') {
      // 폴더 구조 보존(맥락) — 각 조각을 정리해 files/imported/ 아래로
      const segs = e.rel.split('/');
      const extIdx = segs[segs.length - 1].lastIndexOf('.');
      const ext = extIdx > 0 ? segs[segs.length - 1].slice(extIdx).toLowerCase() : '';
      const stem = extIdx > 0 ? segs[segs.length - 1].slice(0, extIdx) : segs[segs.length - 1];
      const dir = join(filesRoot, ...segs.slice(0, -1).map(sanitizeSegment));
      await mkdirIfRun(dir, dryRun); // 이름 풀이 readdir 기반이라 실행 시엔 폴더가 먼저 있어야 일관 — 드라이런은 안 만든다
      const name = await reserve(dir, [sanitizeSegment(stem)], ext);
      const relDir = ['files', 'imported', ...segs.slice(0, -1).map(sanitizeSegment)].join('/');
      plan.push({ ...e, dest, isMd: false, target: join(dir, name), targetRel: `vault/${relDir}/${name}` });
      mapAtt(e.rel, `${relDir}/${name}`);
    } else if (dest === 'unsorted') {
      const segs = e.rel.split('/').map(sanitizeSegment);
      const dir = join(unsortedRoot, ...segs.slice(0, -1));
      await mkdirIfRun(dir, dryRun);
      const last = segs[segs.length - 1];
      const dotIdx = last.lastIndexOf('.');
      const name = await reserve(dir, [dotIdx > 0 ? last.slice(0, dotIdx) : last], dotIdx > 0 ? last.slice(dotIdx) : '');
      plan.push({ ...e, dest, reason, isMd: false, target: join(dir, name), targetRel: `vault/_imported/unsorted/${[...segs.slice(0, -1), name].join('/')}` });
      unsorted.push({ rel: e.rel, reason });
    } else {
      skipped.push({ rel: e.rel, reason }); // too-large·sensitive — 복사 없이 건별 안내(원본은 볼트에 그대로)
    }
  }

  const counts = {
    journal: plan.filter((x) => x.dest === 'journal').length,
    notes: plan.filter((x) => x.dest === 'notes').length,
    files: plan.filter((x) => x.dest === 'files').length,
    unsorted: unsorted.length,
    already: already.length,
    skipped: skipped.length,
    configSkipped,
    total: entries.length,
  };
  const cap = (list, n) => list.slice(0, n);
  const summary = {
    dryRun,
    src,
    ...counts,
    unsortedItems: cap(unsorted, 200),
    skippedItems: cap(skipped, 200),
    // 첨부로 "무엇이" 들어오는지 실행 전에 보여준다 — 개수만 보여주면 볼트 아닌 폴더를 고른
    // 오조작(문서 폴더 통째 등)을 사용자가 알아챌 지점이 없다(검수 HIGH-1의 UI 축).
    filesItems: cap(plan.filter((x) => x.dest === 'files').map((x) => x.rel), 200),
    warnings: cap(warnings, 50),
  };
  if (dryRun) return summary;

  // ── 실행: 복사·쓰기. 실패 시 남은 것은 중단하되, 이미 배치된 것은 그대로 둔다(추가형 — 손상 없음).
  //    manifest는 성공분까지 반영해 재실행이 이어받는다.
  let done = 0;
  await mkdir(join(p.vault, '_imported'), { recursive: true }); // manifest 주기 저장·리포트가 여기 산다
  await writeStatus(wsId, { phase: 'copy', done, total: plan.length });
  try {
    for (const item of plan) {
      await mkdir(dirname(item.target), { recursive: true });
      if (item.isMd) {
        // 쓰기 시점 재읽기(플랜에 본문 보관 금지 — 검수 MED-1) + 원자 쓰기(반쪽 노트 방지)
        const content = await readFile(join(src, item.rel), 'utf8');
        await writeJsonAtomic(item.target, rewriteLinks(content, { noteMap, attMap, wsId }));
      } else {
        await copyFile(join(src, item.rel), item.target); // mode 복원 없음 — export.mjs와 같은 근거(exFAT 함정)
      }
      // 원본 mtime 복원 — 10년치 노트가 전부 "오늘 갱신"이 되어 인덱스 최상단을 점령하는 것 방지
      await utimes(item.target, item.mtime, item.mtime).catch(() => {});
      srcBook[item.rel] = { target: item.targetRel, size: item.size, mtimeMs: item.mtime.getTime() };
      done += 1;
      if (done % 25 === 0) {
        await writeStatus(wsId, { phase: 'copy', done, total: plan.length });
        await writeJsonAtomic(manifestFile(wsId), manifest).catch(() => {}); // 중단돼도 재실행이 이어받게 주기 저장
      }
    }
  } catch (e) {
    await writeJsonAtomic(manifestFile(wsId), manifest).catch(() => {});
    await writeStatus(wsId, { phase: 'error', error: String(e.message || e), done, total: plan.length });
    throw err('copy-failed', String(e.message || e));
  }
  await writeJsonAtomic(manifestFile(wsId), manifest);

  // 리포트 — 회사 언어. UI 요약(JSON)과 달리 전체 목록을 남긴다(캡 없음).
  const lang = (await loadCompany(wsId).catch(() => null))?.lang === 'en' ? 'en' : 'ko';
  const L = REASON_LABEL[lang];
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportRel = `vault/_imported/report-${ts}.md`;
  const lines = lang === 'ko' ? [
    `# 옵시디언 가져오기 리포트 — ${ts}`,
    '',
    `- 원본 볼트: ${src} (읽기만 했습니다 — 원본은 그대로입니다)`,
    `- 일지 ${counts.journal} · 노트 ${counts.notes} · 첨부 ${counts.files} · 미분류 ${counts.unsorted} · 이미 가져옴 ${counts.already} · 건너뜀 ${counts.skipped} (설정·숨김 항목 ${configSkipped})`,
    '',
    ...(unsorted.length ? ['## 미분류 — vault/_imported/unsorted/ 에 원본 그대로 보관', ...unsorted.map((u) => `- ${u.rel} — ${L[u.reason] ?? u.reason}`), ''] : []),
    ...(skipped.length ? ['## 건너뜀 — 복사하지 않음(원본은 볼트에 그대로)', ...skipped.map((s) => `- ${s.rel} — ${L[s.reason] ?? s.reason}`), ''] : []),
    ...(warnings.length ? ['## 경고', ...warnings.map((w) => `- ${w.rel} — ${L[w.reason] ?? w.reason}`), ''] : []),
  ] : [
    `# Obsidian import report — ${ts}`,
    '',
    `- Source vault: ${src} (read-only — your vault is untouched)`,
    `- Journal ${counts.journal} · Notes ${counts.notes} · Files ${counts.files} · Unsorted ${counts.unsorted} · Already imported ${counts.already} · Skipped ${counts.skipped} (config/hidden ${configSkipped})`,
    '',
    ...(unsorted.length ? ['## Unsorted — kept as-is under vault/_imported/unsorted/', ...unsorted.map((u) => `- ${u.rel} — ${L[u.reason] ?? u.reason}`), ''] : []),
    ...(skipped.length ? ['## Skipped — not copied (originals stay in your vault)', ...skipped.map((s) => `- ${s.rel} — ${L[s.reason] ?? s.reason}`), ''] : []),
    ...(warnings.length ? ['## Warnings', ...warnings.map((w) => `- ${w.rel} — ${L[w.reason] ?? w.reason}`), ''] : []),
  ];
  await writeJsonAtomic(join(p.root, reportRel), lines.join('\n') + '\n');

  await updateIndex(wsId).catch(() => {}); // 인덱스 실패가 임포트 성공을 뒤집지 않는다(파일은 이미 안전)
  const result = { ...summary, reportRel };
  await writeStatus(wsId, { phase: 'done', ...counts });
  return result;
}

/** 실행 모드에서만 폴더 생성 — 드라이런은 어떤 쓰기도 하지 않는다는 계약 유지. */
async function mkdirIfRun(dir, dryRun) {
  if (!dryRun) await mkdir(dir, { recursive: true });
}
