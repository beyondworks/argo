// 외부 작업 폴더(work roots) — 사장이 지정한 워크스페이스 밖 폴더를 크루의 "확장 책상"으로 연다.
//
// 배경(실사용 신고 최다 클러스터 2026-07-26~27, 11건/제보자 7명): codex 러너의 writable_roots가
// 홈으로 하드코딩돼 홈 밖 프로젝트(C:\services, D:\ChatGPT2CodexWorkspace, 외장 SSD)가 구조적으로
// 막혔고, SDK 러너도 "fs 능력 = 홈 전체 개방"밖에 선택지가 없었다. 지정 폴더 모델은 그보다 좁고
// 명시적이다 — "전부 열기(fs)"가 아니라 "이 폴더만 열기". fs 능력과 독립적으로 동작한다.
//
// 보안 경계(불변):
//  - 금지 구역은 지정으로도 열리지 않는다 — 앱 코드 루트·~/.argo·WS_ROOT(전 회사 데이터)는 루트로
//    등록 자체를 거부하고, 게이트(permission-gate)의 isForbidden 하드 차단은 지정 폴더 안에서도 선행한다.
//  - 파일시스템 루트('/'·드라이브 루트 'X:\')는 너무 넓어 거부 — writable_roots="/"가 앱 본체까지
//    열었던 2026-07-22 크리티컬의 재연 차단. 외장 볼륨(/Volumes/T7)·드라이브 하위 폴더(D:\work)는 허용.
//  - 검증은 realpath canonical 기준 — 심링크로 금지 구역을 등록하지 못한다.
//  - 저장 파일은 워크스페이스 직속 **도트파일**(.workroots.json) — 게이트의 직속 도트파일 차단에 얹혀
//    크루가 파일 도구로 스스로 루트를 추가하는 자가 승격을 막는다(설정 UI/API만 쓸 수 있다).
//  - 기기 로컬(동기화 제외 — sync.mjs EXCLUDE): 경로는 기기 고유값이라 타 기기로 넘기면 무의미하거나,
//    최악엔 그 기기에서 의도 안 한 폴더가 열린다. 기기마다 그 기기의 경로를 따로 등록한다.
//
// 러너별 집행(정직 표기 — UI 문구와 일치 유지):
//  - claude/glm/kimi(SDK): permission-gate가 지정 폴더를 책상으로 판정 + SDK additionalDirectories.
//  - codex: writable_roots에 추가(프로세스 단위 샌드박스 — fs 능력의 기존 한계와 동일).
//  - gemini/antigravity: 경로 샌드박스가 없어 프롬프트 안내(commonDirectives)로만 전달된다.
import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths, WS_ROOT } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

export const MAX_WORK_ROOTS = 8; // 폴더 수 상한 — 프롬프트·config 비대 방지(필요가 실증되면 올린다)
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // permission-gate와 같은 계산

const err = (code, msg) => Object.assign(new Error(msg), { code });
const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
// 케이스 폴딩 — macOS(APFS 기본)·Windows(NTFS)는 대소문자 무시 파일시스템이라 `C:\USERS\...` 같은
// 케이스 변형 경로도 같은 실체를 가리킨다. Node의 JS realpath는 Windows에서 입력 케이스를 보존하므로
// 문자열 비교만으로는 보호 구역 판정(inside)이 케이스 변형에 뚫린다(앱 루트를 케이스 바꿔 등록하면
// writable_roots에 앱 본체가 실리는 2026-07-22 크리티컬 계열). 비교 시에만 폴딩하고 저장은 canonical 그대로.
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p) => (FOLD ? String(p).toLowerCase() : p);
const inside = (p, r) => fold(p) === fold(r) || fold(p).startsWith(`${fold(r)}${sep}`);

/** 등록된 루트 목록. 손상은 fail-closed([])가 안전 방향(접근이 줄어들 뿐)이라 lenient —
    capabilities(throw)와 다른 근거: 여기서 throw하면 채팅 턴 전체가 죽는데, 얻는 보안이 없다. */
export async function loadWorkRoots(wsId) {
  const data = await readJsonLenient(paths(wsId).workroots, { roots: [] });
  return Array.isArray(data?.roots) ? data.roots.filter((r) => typeof r === 'string' && r.trim()) : [];
}

/** 턴 주입용 — 이 기기에 지금 존재하고 **지금도 검증을 통과하는** 루트만(canonical 반환).
    존재 필터: 분리된 외장 디스크·과거 잔재 경로가 턴을 깨지 않게 조용히 제외(재연결 시 자동 복귀).
    재검증: 등록 후 폴더가 보호 구역 심링크로 교체돼도 주입 시점에 걸린다(TOCTOU —
    분리 검수 MED-2 2026-07-28). 어차피 루트마다 stat을 돌던 자리라 비용 증가는 없다. */
export async function loadActiveWorkRoots(wsId) {
  const roots = await loadWorkRoots(wsId);
  const checks = await Promise.all(roots.map((r) => validateWorkRoot(r).catch(() => null)));
  return checks.filter(Boolean);
}

/** 등록 검증 — 성공 시 canonical 경로 반환, 실패 시 코드 있는 Error throw.
    코드는 UI가 i18n으로 매핑한다(서버 한국어 하드코딩 금지 — 러너 감사 K7 계열 예방).
    (export: 회귀 테스트용) */
export async function validateWorkRoot(p, { appRoot = APP_ROOT, wsRoot = WS_ROOT } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw err('invalid', 'empty path');
  const trimmed = p.trim();
  if (!isAbsolute(trimmed)) throw err('not-absolute', trimmed);
  const st = await stat(trimmed).catch(() => null);
  if (!st) throw err('not-found', trimmed);
  if (!st.isDirectory()) throw err('not-dir', trimmed);
  const real = (await canon(trimmed)) ?? resolve(trimmed);
  // 루트 전체는 거부 — 하위 폴더(외장 디스크 전체가 필요하면 D:\work 같은 폴더)를 지정하게 한다.
  // UNC 공유 루트(\\server\share)도 같은 계열(분리 검수 LOW 2026-07-28).
  if (real === '/' || /^[A-Za-z]:[\\/]?$/.test(real) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(real)) throw err('too-broad', real);
  const [appRootCanon, argoHomeCanon, wsRootCanon] = await Promise.all(
    [resolve(appRoot), join(homedir(), '.argo'), resolve(wsRoot)].map(async (r) => (await canon(r)) ?? resolve(r)),
  );
  for (const r of [appRootCanon, argoHomeCanon, wsRootCanon]) if (inside(real, r)) throw err('protected', real);
  // 조상 등록 차단(분리 검수 HIGH-1 2026-07-28): 앱 코드 루트를 '포함'하는 루트는 codex
  // writable_roots에 실리는 순간 앱 본체 쓰기가 열린다 — writable_roots="/"였던 2026-07-22
  // 크리티컬의 조상 변종. SDK는 게이트(isForbidden)가 막지만 codex는 프로세스 단위라 등록에서 막는다.
  if (inside(appRootCanon, real)) throw err('protected', real);
  // 주의: ~/.argo·WS_ROOT를 '포함'하는 루트(예: 홈 전체)는 의도적으로 허용한다 — fs 능력(홈 개방)의
  // 기존 한계와 동일 계열이고, SDK 게이트는 여전히 선행 차단한다. 이 한계는 UI가 러너별로 정직 표기.
  return real;
}

/** 추가/삭제 — 한 번에 하나씩(설정 UI 계약). 저장은 canonical 경로. */
export async function updateWorkRoots(wsId, { add = null, remove = null } = {}) {
  return withLock(`workroots:${wsId}`, async () => {
    let roots = await loadWorkRoots(wsId);
    if (typeof remove === 'string' && remove.trim()) {
      roots = roots.filter((r) => r !== remove.trim());
    }
    if (typeof add === 'string' && add.trim()) {
      const real = await validateWorkRoot(add);
      if (roots.some((r) => fold(r) === fold(real))) throw err('duplicate', real); // 케이스 변형 중복 방지
      if (roots.length >= MAX_WORK_ROOTS) throw err('limit', String(MAX_WORK_ROOTS));
      roots = [...roots, real];
    }
    await writeJsonAtomic(paths(wsId).workroots, { roots });
    return roots;
  });
}
