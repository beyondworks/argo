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
//  - gemini: `--include-directories`에 추가. (2026-07-30 정정 — 이전 주석은 "경로 샌드박스가 없어
//    안내로만 전달"이라 적었는데 **정반대였다**: gemini-cli는 workspaceContext 밖 읽기·쓰기를 벤더
//    도구가 거부한다. 인자를 안 넘기면 지정 폴더는커녕 홈조차 막혀 크루가 "허용된 작업 디렉토리
//    외부"라며 거절한다 — 라이브 재현 2026-07-30.)
//  - antigravity: `--add-dir`에 추가(agy 플래그 — 같은 이유·같은 계산).
//  - kiro: **반경이 적용되지 않는다**(정직 표기 대상). kiro-cli는 기본이 무제한이고(cwd 밖 읽기·쓰기가
//    그냥 된다), 좁히는 유일한 수단인 `toolsSettings.*.deniedPaths`로는 화이트리스트를 표현할 수 없다
//    (실측 2026-08-12: allowedPaths는 비대화에서 자동 승인을 주지 못해 반경 안쪽까지 거부되고,
//    denyByDefault는 shell 전용이라 write에서 무시되며, deny 글롭의 부정 패턴 `!`도 미지원).
//    그래서 이 러너의 집행은 **불변 금지 구역 deny**뿐이다 — APP_ROOT·~/.argo·다른 회사·직속 도트
//    (src/runners/kiro.mjs kiroDeniedPaths). 지정 폴더는 열거나 좁히는 효과가 없다.
//    UI 문구(i18n settings.workroots.runnerNote)가 이 차이를 ko·en 양쪽에 명시하고,
//    test/kiro-runner.test.mjs가 그 표기를 잠근다. 근본 해법은 `kiro-cli acp`(도구 호출을 우리가
//    승인·거절 — SDK 러너와 같은 강도)로 옮기는 것: docs/kiro-runner-design.md 후속 항목.
import { stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { paths, WS_ROOT } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { fold, insideFold } from './pathcase.mjs';

export const MAX_WORK_ROOTS = 8; // 폴더 수 상한 — 프롬프트·config 비대 방지(필요가 실증되면 올린다)

/** 크루에게 열어줄 파일 반경(순수) — 홈(fs 능력) + 지정 작업 폴더. **세 외부 CLI가 공유**한다:
    codex writable_roots · gemini --include-directories · antigravity --add-dir.
    러너 중립성(유건 원칙 2026-07-30)의 코드 단일 진실 — 한 러너만 반경이 좁으면 같은 지시가 러너에
    따라 되고 안 되고가 갈린다(실사고: gemini 크루가 홈 파일 쓰기를 거절, 라이브 재현 2026-07-30).
    (export: 회귀 테스트용 — 순수 함수) */
export const openRoots = (caps, workRoots = []) => [...(caps?.fs ? [homedir()] : []), ...workRoots];
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // permission-gate와 같은 계산

const err = (code, msg) => Object.assign(new Error(msg), { code });
const canon = async (t) => { try { return await realpath(t); } catch { return null; } };
// 케이스 폴딩(pathcase.mjs) — 여기서는 **심층 방어**다: fs/promises.realpath가 케이스를 정규화하므로
// 존재하는 경로끼리의 비교는 폴딩 없이도 일치한다(분리 검수 실측 2026-07-28 — 이전 주석이 서술한
// 'JS realpath 케이스 보존' 우회는 이 파일에선 성립하지 않는다). 폴딩이 실제로 막는 것은 canon()
// 실패 시의 `?? resolve()` 폴백(예: ~/.argo 미존재) — 그 경로만 입력 케이스가 보존된다.
// 같은 위협의 **실제 우회 지점**은 permission-gate의 렉시컬 폴백이었고 그쪽 deny 판정에 폴딩을
// 적용해 닫았다(insideFold). 저장은 canonical 그대로, 비교에만 폴딩(원칙·한계는 pathcase.mjs 주석).

/** 등록된 루트 목록. 손상은 fail-closed([])가 안전 방향(접근이 줄어들 뿐)이라 lenient —
    capabilities(throw)와 다른 근거: 여기서 throw하면 채팅 턴 전체가 죽는데, 얻는 보안이 없다. */
export async function loadWorkRoots(wsId) {
  const data = await readJsonLenient(paths(wsId).workroots, { roots: [] });
  return Array.isArray(data?.roots) ? data.roots.filter((r) => typeof r === 'string' && r.trim()) : [];
}

/** 크루별 **고정 작업 폴더**(pins) — "가도 되는 곳"(roots)과 달리 "지금 일할 곳"이다.
    같은 파일에 두는 이유: 경로는 기기 고유값이라 **동기화에서 함께 빠져야** 한다(sync.mjs EXCLUDE).
    크루 카드(agents/*.md)는 동기화되므로 거기 두면 다른 기기로 넘어가 없는 폴더를 가리킨다
    — 첫 구현이 실제로 그랬다. 검증·잠금·도트파일 보호도 여기 얹으면 그대로 물려받는다. */
export async function loadPins(wsId) {
  const data = await readJsonLenient(paths(wsId).workroots, { pins: {} });
  const pins = data?.pins;
  return pins && typeof pins === 'object' && !Array.isArray(pins) ? pins : {};
}

/** 턴 주입용 고정 폴더 — 등록 목록에서 빠졌거나 지금 검증을 통과 못 하면 **없는 것으로 친다**.
    (설정에서 폴더를 지우면 고정도 자동으로 풀린다. 없는 경로를 "지금 일할 곳"이라 우기지 않는다.)
    roots를 받으면 그걸 쓴다 — activeFolders가 한 번만 재도록. */
export async function activePin(wsId, slug, roots = null) {
  const pinned = (await loadPins(wsId))[slug];
  if (!pinned) return '';
  const list = roots ?? (await loadActiveWorkRoots(wsId));
  return list.some((r) => fold(r) === fold(pinned)) ? pinned : '';
}

/** 한 턴이 쓰는 폴더 상태 — **SDK·CLI 두 경로가 같은 함수를 지난다**(러너 중립성: 유건 지시).
    한 곳에서 한 번만 재는 이유가 둘이다:
     ① 두 번 재면 루트마다 stat+realpath를 두 벌 돈다(턴마다, 루트 수에 비례).
     ② 두 스냅샷이 어긋날 수 있다 — 사이에 폴더가 등록+고정되면 프롬프트는 "여기서 일해라"인데
        샌드박스 목록(codex writable_roots·SDK additionalDirectories)엔 그 폴더가 없다.
        크루가 자기 샌드박스가 막는 곳에서 일하라는 지시를 받는다(분리 검수 2026-07-31). */
export async function activeFolders(wsId, slug) {
  const roots = await loadActiveWorkRoots(wsId);
  return { roots, pin: await activePin(wsId, slug, roots) };
}

/** 고정/해제 — 빈 값이면 해제. 고정은 **등록된 폴더 중에서만** 고를 수 있다(roots가 상위 계약). */
export async function setPin(wsId, slug, path) {
  return withLock(`workroots:${wsId}`, async () => {
    const data = await readJsonLenient(paths(wsId).workroots, { roots: [], pins: {} });
    const roots = Array.isArray(data?.roots) ? data.roots : [];
    const pins = { ...(data?.pins && typeof data.pins === 'object' && !Array.isArray(data.pins) ? data.pins : {}) };
    const want = String(path ?? '').trim();
    if (!want) delete pins[slug];
    else {
      const real = await validateWorkRoot(want); // 등록과 같은 검증 — 고정만 우회하는 구멍을 안 만든다
      const hit = roots.find((r) => fold(r) === fold(real));
      if (!hit) throw err('not-registered', real);
      pins[slug] = hit; // 저장은 등록된 정본 문자열 — 화면이 목록과 대조할 수 있게
    }
    await writeJsonAtomic(paths(wsId).workroots, { ...data, roots, pins });
    return pins[slug] ?? '';
  });
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
  for (const r of [appRootCanon, argoHomeCanon, wsRootCanon]) if (insideFold(real, r)) throw err('protected', real);
  // 조상 등록 차단(분리 검수 HIGH-1 2026-07-28): 앱 코드 루트를 '포함'하는 루트는 codex
  // writable_roots에 실리는 순간 앱 본체 쓰기가 열린다 — writable_roots="/"였던 2026-07-22
  // 크리티컬의 조상 변종. SDK는 게이트(isForbidden)가 막지만 codex는 프로세스 단위라 등록에서 막는다.
  if (insideFold(appRootCanon, real)) throw err('protected', real);
  // 주의: ~/.argo·WS_ROOT를 '포함'하는 루트(예: 홈 전체)는 의도적으로 허용한다 — fs 능력(홈 개방)의
  // 기존 한계와 동일 계열이고, SDK 게이트는 여전히 선행 차단한다. 이 한계는 UI가 러너별로 정직 표기.
  return real;
}

/** 추가/삭제 — 한 번에 하나씩(설정 UI 계약). 저장은 canonical 경로. */
export async function updateWorkRoots(wsId, { add = null, remove = null } = {}) {
  return withLock(`workroots:${wsId}`, async () => {
    const data = await readJsonLenient(paths(wsId).workroots, { roots: [], pins: {} });
    let roots = Array.isArray(data?.roots) ? data.roots.filter((r) => typeof r === 'string' && r.trim()) : [];
    const pins = { ...(await loadPins(wsId)) }; // 삭제된 폴더의 고정은 같이 푼다(부활 방지)
    if (typeof remove === 'string' && remove.trim()) {
      roots = roots.filter((r) => fold(r) !== fold(remove.trim())); // add와 대칭 — 케이스 변형 삭제 허용
      for (const [slug, p] of Object.entries(pins)) if (fold(p) === fold(remove.trim())) delete pins[slug];
    }
    if (typeof add === 'string' && add.trim()) {
      const real = await validateWorkRoot(add);
      if (roots.some((r) => fold(r) === fold(real))) throw err('duplicate', real); // 케이스 변형 중복 방지
      if (roots.length >= MAX_WORK_ROOTS) throw err('limit', String(MAX_WORK_ROOTS));
      roots = [...roots, real];
    }
    await writeJsonAtomic(paths(wsId).workroots, { ...data, roots, pins }); // setPin과 대칭 — 미지 키 보존
    return roots;
  });
}
