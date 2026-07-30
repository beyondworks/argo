// 산출물 스냅샷·diff — "이 턴에 사용자에게 줄 파일이 생겼나"를 **러너 무관**하게 잡는다.
//
// 배경(실사용 제보 2026-07-30: "만들었다는데 못 찾는다·다운로드가 없다"): 기존 수집은 SDK 스트림의
// Write/Edit tool_use 관측뿐이라 ① Bash(pandoc·python·리다이렉트)로 만든 파일 ② MCP 파일도구
// ③ 외부 CLI 러너(codex/gemini/antigravity) 턴 전체가 사각이었다 — xlsx·pptx·pdf가 보통 그 경로로
// 만들어진다. 파일시스템이 단일 진실이므로 **턴 전후 diff가 정본**이고, 도구 관측은 보조다.
// 러너 중립성 원칙(2026-07-30)의 산출물 판: 어떤 러너가 만들었든 같은 칩이 떠야 한다.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// 비md 산출물의 칩 허용 접두 = files API(app/api/companies/[ws]/files) 허용 접두와 **동일 목록**.
// 갈라지면 "칩은 뜨는데 누르면 400"이 재발한다(탐색 G8 — vault 직속 xlsx가 그랬다).
export const SERVE_PREFIXES = ['projects/', 'files/', '_imported/'];
const SCAN_ROOTS = ['projects', 'files', '_imported'];

/** vault 산출물 구역 스냅샷 — rel → "mtimeMs:size". 부재 폴더·경합 삭제는 조용히 건너뛴다.
    심링크 미추적(readdir dirent 판정 — isFile/isDirectory는 링크 자체를 따르지 않는다). */
export async function snapshotArtifacts(vaultDir) {
  const map = new Map();
  for (const root of SCAN_ROOTS) await walk(join(vaultDir, root), root, map);
  return map;
}

async function walk(abs, rel, map) {
  let entries = [];
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; } // 부재 = 빈 구역
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 도트 항목 — 상태·마커류는 산출물이 아니다
    const a = join(abs, e.name);
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(a, r, map);
    else if (e.isFile()) {
      try { const s = await stat(a); map.set(r, `${s.mtimeMs}:${s.size}`); } catch { /* 경합 삭제 */ }
    }
  }
}

/** 턴 전후 diff — 새로 생겼거나 내용이 바뀐 rel 목록(정렬). 삭제는 칩 대상이 아니다. */
export function diffArtifacts(before, after) {
  const out = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) out.push(rel);
  return out.sort();
}

/** 칩으로 내보낼 수 있는 rel인가 — md는 뷰어(vault?doc=)가 vault 전역을 열 수 있으니 journal/만
    제외(일지는 전용 칩이 따로 있다). 비md는 files API 서빙 접두만 — 목록 밖이면 눌러도 400이다. */
export function servableArtifact(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('journal/')) return false;
  if (rel.endsWith('.md')) return true;
  return SERVE_PREFIXES.some((p) => rel.startsWith(p));
}
