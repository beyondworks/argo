// 산출물 스냅샷·diff — "이 턴에 사용자에게 줄 파일이 생겼나"를 **러너 무관**하게 잡는다.
//
// 배경(실사용 제보 2026-07-30: "만들었다는데 못 찾는다·다운로드가 없다"): 기존 수집은 SDK 스트림의
// Write/Edit tool_use 관측뿐이라 ① Bash(pandoc·python·리다이렉트)로 만든 파일 ② MCP 파일도구
// ③ 외부 CLI 러너(codex/gemini/antigravity) 턴 전체가 사각이었다 — xlsx·pptx·pdf가 보통 그 경로로
// 만들어진다. 파일시스템이 단일 진실이므로 **턴 전후 diff가 정본**이고, 도구 관측은 보조다.
// 러너 중립성 원칙(2026-07-30)의 산출물 판: 어떤 러너가 만들었든 같은 칩이 떠야 한다.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
// 순수부(접두 목록·칩 판정)는 artifact-zones로 분리 — ui.jsx(클라 번들)가 쓴다. 재export로 임포터 무수정.
export { SERVE_PREFIXES, servableArtifact } from './artifact-zones.mjs';

// notes도 스캔 — md 칩은 SDK(도구 관측)만 받고 CLI는 못 받던 러너별 편차 해소(검수 LOW-1).
// 비md는 servableArtifact가 걸러 서빙 불일치는 생기지 않는다.
const SCAN_ROOTS = ['projects', 'files', '_imported', 'notes'];

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

/** 상한 + 최신 우선(순수) — 복원·임포트가 턴과 겹치면 diff가 수백 개로 폭발한다(검수 실측 420칩).
    after 스냅샷의 mtime으로 내림차순 정렬 후 cap. 초과분은 기억 화면(listProjectDocs)이 담당. */
export function capLatest(after, rels, cap = 12) {
  const m = (r) => Number(String(after.get(r) ?? '0:0').split(':')[0]);
  return [...rels].sort((a, b) => m(b) - m(a) || (a < b ? -1 : 1)).slice(0, cap);
}
