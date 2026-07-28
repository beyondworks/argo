// 옵시디언 볼트 임포트 — 외부 볼트를 Argo 스캐폴드(journal·notes·files)로 증류 복사한다.
// 설계 정본: docs/obsidian-import-design.md. 제품 원칙: "옵시디언 임포트 = Argo 스캐폴드 재분류".
//
// 불변 원칙:
//  - 원본 볼트는 읽기 전용 — 소스에 단 1바이트도 쓰지 않는다(임포트 = 복사).
//  - 기존 회사 데이터를 덮지 않는다 — 대상 충돌은 접미 번호(-2, -3)로 분리(기억 유실 금지).
//  - 증류 불가는 버리지 않는다 — vault/_imported/unsorted/에 보존하고 건별 이유를 리포트에 싣는다.
//  - 러너 없이 완결 — 규칙 기반만으로 끝난다(LLM 증류는 Phase 2).
//  - 서버 한국어 하드코딩 금지(K7 계열) — 오류·이유는 코드로, UI가 i18n 매핑.
//    리포트 md 파일만 회사 언어(company.json lang)를 따른다(크루 기억 노트와 같은 규약).
//
// 규모(관문 0.5): 사용자 1회성 액션 — 상시 타이머 없음. 비용은 볼트 크기에 선형(복사 1회 +
// 이후 동기화 1회 업로드). 상한(파일 2만·합계 2GB)으로 클라우드 동기화 폭주를 사전 차단한다.
import { readdir, readFile, copyFile, mkdir, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { validateWorkRoot } from './workroots.mjs';
import { updateIndex } from './memory.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

const err = (code, msg) => Object.assign(new Error(msg), { code });

export const MAX_FILE_BYTES = 200 * 1024 * 1024;      // 단일 파일 상한 — 초과는 복사 없이 리포트(원본은 볼트에 그대로)
export const MAX_COUNT = 20_000;                       // 총 파일 수 상한 — 워크스페이스는 동기화 대상이라 무한정 못 싣는다
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 총 용량 상한 — 같은 근거

// Argo files/ 서빙(files/route.js MIME)과 옵시디언 통용 첨부의 교집합 위주 — 여기 없으면 미분류로
// 정직하게 보낸다(조용히 버리지 않는다).
const ATTACH_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'mp3', 'wav', 'm4a', 'mp4', 'mov', 'zip', 'pptx', 'docx', 'xlsx', 'csv', 'txt', 'json', 'html']);
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const DAILY_RE = /^(\d{4}-\d{2}-\d{2})(.*)\.md$/i;     // 옵시디언 Daily Notes 기본 형식(+ 뒤 수식어 허용)
const TEMPLATE_SEG = /^_?templates?$|^템플릿$/i;

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
      const url = `/api/companies/${wsId}/files?rel=${encodeURIComponent(att)}`;
      const label = basename(target);
      return bang && IMG_EXT.has(att.split('.').pop().toLowerCase()) ? `![${label}](${url})` : `[${label}](${url})`;
    }
    return whole; // 미임포트·외부 타깃 — 임의 추측 재작성 금지
  });
}

/* ── 진행 상태 — 직속 도트파일(.import-status.json): sync EXCLUDE·export 제외가 자동 적용된다. */
const statusFile = (wsId) => join(paths(wsId).root, '.import-status.json');

export async function readImportStatus(wsId) {
  return readJsonLenient(statusFile(wsId), { phase: 'idle' });
}

async function writeStatus(wsId, status) {
  await writeJsonAtomic(statusFile(wsId), { ...status, at: new Date().toISOString() }).catch(() => {});
}

/* ── 재실행 대장(manifest) — 소스 파일 → 배치된 타깃. 같은 볼트를 다시 가져오면 변화분만 추가되고
   (미변경 = already-imported), 링크 맵은 기존 타깃을 재사용한다. 소스가 바뀐 파일은 덮지 않고
   새 사본(접미 번호)으로 들어간다 — 기억 유실 금지. */
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

/** 대상 파일명 확보 — 디렉터리 내 미사용 이름(기존 파일·이번 실행 배정 모두 회피). */
function resolveName(dir, base, ext, used) {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
    const key = `${dir}/${name}`.toLowerCase();
    if (!used.has(key) && !existsSync(join(dir, name))) { used.add(key); return name; }
  }
}

const REASON_LABEL = {
  ko: { template: '템플릿(서식) 폴더', empty: '빈 노트', 'unknown-type': 'Argo가 읽을 수 없는 형식', 'too-large': '200MB 초과 — 복사하지 않음(원본은 볼트에 그대로)', symlink: '심링크(바로가기) — 복사하지 않음', 'ambiguous-link': '같은 이름의 노트가 여러 개 — 링크는 먼저 배치된 쪽으로 연결' },
  en: { template: 'template folder', empty: 'empty note', 'unknown-type': 'format Argo cannot read', 'too-large': 'over 200MB — not copied (original stays in your vault)', symlink: 'symlink — not copied', 'ambiguous-link': 'duplicate note names — links point to the first one placed' },
};

/** 옵시디언 볼트 임포트 본체. dryRun=true면 복사 없이 분류 계획만 반환한다. */
export async function importObsidianVault(wsId, srcPath, { dryRun = false } = {}) {
  const p = paths(wsId);
  if (!existsSync(p.company)) throw err('no-company', wsId);
  // 소스 검증 재사용 — 절대경로·존재·디렉토리·루트 전체 거부·보호 구역(WS_ROOT 포함) 거부·realpath 봉인.
  // WS_ROOT 안이 거부되므로 자기 워크스페이스 재귀 임포트가 원천 차단된다.
  const src = await validateWorkRoot(srcPath);
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
  const used = new Set();
  const plan = [];               // { rel, size, mtime, dest, reason, target(절대), targetRel(워크스페이스 표시용), content? }
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
    if (prev && prev.size === e.size && prev.mtimeMs === e.mtime.getTime() && existsSync(join(p.root, prev.target))) {
      already.push({ rel: e.rel, reason: 'already-imported' });
      // 재실행에서도 기존 타깃으로 링크가 이어지게 맵에 싣는다(vault 기준 rel로 변환)
      if (prev.target.startsWith('vault/') && /\.md$/i.test(prev.target) && !prev.target.startsWith('vault/_imported/')) {
        mapNote(e.rel, prev.target.slice('vault/'.length).replace(/\.md$/i, ''));
      } else if (prev.target.startsWith('vault/files/')) {
        mapAtt(e.rel, prev.target.slice('vault/'.length));
      }
      continue;
    }
    let { dest, reason } = classifyVaultEntry(e.rel, e.size);
    let content = null;
    if (dest === 'journal' || dest === 'notes') {
      content = await readFile(join(src, e.rel), 'utf8').catch(() => null);
      if (content === null) { dest = 'unsorted'; reason = 'unknown-type'; } // utf8로 못 읽는 .md — 미분류로 정직하게
      else if (!content.trim()) { dest = 'unsorted'; reason = 'empty'; }
    }
    const base = basename(e.rel);
    if (dest === 'journal') {
      const m = base.match(DAILY_RE);
      const rest = m[2] ? sanitizeSegment(m[2]) : '';
      // vaultdoc.docKind의 일지 판정(^\d{4}-\d{2}-\d{2}-)에 맞는 이름 — 인덱스 "최근 일지" 구간에 잡힌다
      const name = resolveName(p.journal, `${m[1]}-${rest && rest !== 'untitled' ? `${rest}-` : ''}imported`, '.md', used);
      plan.push({ ...e, dest, content, target: join(p.journal, name), targetRel: `vault/journal/${name}` });
      mapNote(e.rel, `journal/${name.replace(/\.md$/, '')}`);
    } else if (dest === 'notes') {
      // notes/는 평면이 정본 구조(listDocs 비재귀) — 폴더 경로는 버리고 파일명만. 충돌은 접미 번호.
      const name = resolveName(p.notes, sanitizeSegment(base.replace(/\.md$/i, '')), '.md', used);
      plan.push({ ...e, dest, content, target: join(p.notes, name), targetRel: `vault/notes/${name}` });
      mapNote(e.rel, `notes/${name.replace(/\.md$/, '')}`);
    } else if (dest === 'files') {
      // 폴더 구조 보존(맥락) — 각 조각을 정리해 files/imported/ 아래로
      const segs = e.rel.split('/');
      const extIdx = segs[segs.length - 1].lastIndexOf('.');
      const ext = extIdx > 0 ? segs[segs.length - 1].slice(extIdx) : '';
      const stem = extIdx > 0 ? segs[segs.length - 1].slice(0, extIdx) : segs[segs.length - 1];
      const dir = join(filesRoot, ...segs.slice(0, -1).map(sanitizeSegment));
      const name = resolveName(dir, sanitizeSegment(stem), ext.toLowerCase(), used);
      const relDir = ['files', 'imported', ...segs.slice(0, -1).map(sanitizeSegment)].join('/');
      plan.push({ ...e, dest, target: join(dir, name), targetRel: `vault/${relDir}/${name}` });
      mapAtt(e.rel, `${relDir}/${name}`);
    } else if (dest === 'unsorted') {
      const segs = e.rel.split('/').map(sanitizeSegment);
      const dir = join(unsortedRoot, ...segs.slice(0, -1));
      const last = segs[segs.length - 1];
      const dotIdx = last.lastIndexOf('.');
      const name = resolveName(dir, dotIdx > 0 ? last.slice(0, dotIdx) : last, dotIdx > 0 ? last.slice(dotIdx) : '', used);
      plan.push({ ...e, dest, reason, target: join(dir, name), targetRel: `vault/_imported/unsorted/${[...segs.slice(0, -1), name].join('/')}` });
      unsorted.push({ rel: e.rel, reason });
    } else {
      skipped.push({ rel: e.rel, reason }); // too-large — 복사 없이 건별 안내(원본은 볼트에 그대로)
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
      if (item.content !== null && item.content !== undefined) {
        // 원자 쓰기(jsonstore) — 강제 종료가 반쪽짜리 노트를 남기지 않는다(문자열은 그대로 기록됨)
        await writeJsonAtomic(item.target, rewriteLinks(item.content, { noteMap, attMap, wsId }));
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
  await mkdir(join(p.vault, '_imported'), { recursive: true });
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
