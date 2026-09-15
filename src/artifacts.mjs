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

/* ─── 턴 귀속(제보 2026-09-15 "보고에 다른 크루가 만든 파일명이 보인다") ───
   diff는 vault 전체라 같은 시간에 다른 크루 턴(회의실 동시 발언·메신저 병렬·루틴·위임)이 돌면 그 크루의 파일이 이 턴 칩에 붙는다
   (compete만 예외였다). 회사 단위 "진행 중 턴 장부"를 두고, 겹치는 턴이 있으면 이 턴이 도구로 쓴 파일 + 이 턴의 답변이 경로로
   언급한 파일만 남기고, 다른 턴이 도구로 쓴 파일은 뺀다. 겹치는 턴이 없으면 종전 그대로(전체 diff). 장부는 globalThis — Next
   번들 사본이 둘이어도 하나(turn-abort와 같은 이유). 누구 것인지 모르는 파일(동시 CLI 턴이 만들고 경로도 안 적음)은 칩에서
   빠지지만 기억 화면에는 그대로 있다 — 오귀속보다 누락이 낫다. */
const LEDGER_RETAIN_MS = 30 * 60_000; // 끝난 턴도 뒤에 끝나는 턴이 겹침을 판정할 수 있게 잠시 남긴다
const LEDGER_STALE_MS = 6 * 3_600_000; // 이보다 오래 "진행 중"인 항목은 닫히지 못한 죽은 턴으로 본다(검수 HIGH-2: 열린 항목이 영구 오염하지 않게)
const ledger = () => (globalThis.__argoTurnLedger ??= new Map()); // wsId → Set<entry>
const dead = (e, t) => (e.endedAt != null ? t - e.endedAt > LEDGER_RETAIN_MS : t - e.startedAt > LEDGER_STALE_MS);
/** 장부 항목 열기 — startedAt은 스냅샷 시각(호출은 모델 호출을 감싸는 try 안에서: 그 앞에서 던지면 항목이 아예 안 생긴다 — 검수 HIGH-2). */
export function openTurnLedger(wsId, slug, { now = Date.now, book = ledger(), startedAt = null } = {}) {
  const set = book.get(wsId) ?? new Set(); book.set(wsId, set);
  const t = now();
  for (const e of set) if (dead(e, t)) set.delete(e);
  const entry = { slug, startedAt: startedAt ?? t, endedAt: null, observed: new Set() };
  set.add(entry);
  return entry;
}
export function closeTurnLedger(entry, { now = Date.now } = {}) { if (entry && entry.endedAt == null) entry.endedAt = now(); }
/** 이 턴과 시간이 겹친 **다른 크루**의 턴들(같은 회사). 같은 크루의 프레임(크래시·자가치유 재시도가 catch 안에서 chat()을 다시 부른다 —
    바깥 프레임이 아직 열려 있다)은 겹침이 아니다(검수 HIGH-1). 죽은 항목은 제외. 끝난 턴은 endedAt, 진행 중은 now 기준. */
export function overlappingTurns(wsId, entry, { now = Date.now, book = ledger() } = {}) {
  const t = now(); const end = entry.endedAt ?? t;
  return [...(book.get(wsId) ?? [])].filter((e) => e !== entry && e.slug !== entry.slug && !dead(e, t) && e.startedAt <= end && (e.endedAt ?? t) >= entry.startedAt);
}
/** 순수 귀속: 겹침 없음 → changed 그대로. 겹침 있음 → (내 도구 관측 ∪ 답변에 경로로 언급) − 다른 턴 도구 관측. */
export function attributeArtifacts(changed, { entry, others = [], reply = '' } = {}) {
  if (!others.length) return changed;
  const foreign = new Set(others.flatMap((o) => [...o.observed]));
  const text = String(reply ?? '');
  return changed.filter((rel) => !foreign.has(rel) && (entry?.observed.has(rel) || text.includes(rel)));
}
