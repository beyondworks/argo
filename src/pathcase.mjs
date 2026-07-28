// 경로 케이스 폴딩(비교 전용) — 대소문자 무시 파일시스템(macOS APFS 기본·Windows NTFS)에서
// 케이스 변형 경로는 같은 실체를 가리킨다. fs/promises.realpath는 케이스를 **정규화**하지만(네이티브
// 바인딩 — 분리 검수 실측 2026-07-28), realpath가 실패하는 렉시컬 폴백(미존재 대상·미존재 부모,
// `?? resolve()`/`?? abs`)은 입력 케이스를 보존한다 — 그 폴백 경로에서 문자열 비교가 케이스 변형에
// 뚫린다(permission-gate 하드 차단 우회, 격리 재현: ~/.ARGO/NS/DEEP 신규 하위 트리 생성 허용됨).
// 원칙: **거부(deny) 판정에만 폴딩한다.** 허용 판정에 폴딩하면 허용이 넓어진다(fail-open) —
// 케이스 변형이 책상 판정에서 떨어지는 건 UX 마찰일 뿐 안전 방향이다.
// 한계: 케이스 민감 마운트(케이스센시티브 APFS·fsutil setCaseSensitiveInfo)에선 케이스만 다른
// 실제 별개 폴더를 과차단한다 — fail-safe 방향이라 수용(필요 실증 시 마운트별 감지로 좁힌다).
// toLowerCase는 로케일 무관(ECMA-262) — 터키어 I 함정은 toLocaleLowerCase 쪽 얘기다.
import { sep } from 'node:path';

export const FOLD = process.platform === 'win32' || process.platform === 'darwin';
export const fold = (p) => (FOLD ? String(p).toLowerCase() : p);
/** deny 전용 — p가 root 안(또는 root 자신)인가를 케이스 폴딩으로 판정 */
export const insideFold = (p, r) => fold(p) === fold(r) || fold(p).startsWith(`${fold(r)}${sep}`);
