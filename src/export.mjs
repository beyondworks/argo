// 회사 데이터 내보내기 — 사장이 지정한 폴더로 회사 워크스페이스를 통째로 복사한다(백업·이사·보관).
//
// 배경(2026-07-28 유건 제품 판단): A갈래 신고(데이터를 외장 SSD·다른 드라이브로, 4건/4명)에 대해
// 위치 변경(Rust 수정·데이터 이동이 걸린 고위험)보다 저위험한 내보내기를 먼저 출하한다.
// 크루에게 시키는 추출은 외부 작업 폴더(workroots)로 회사 단위는 이미 가능하지만, "자격 제외가
// 보장된 표준 경로"는 앱 기능이어야 한다 — 크루는 타사 데이터 금지구역이라 전체 추출도 불가.
//
// 보안(불변): 자격·시크릿을 담는 파일은 복사하지 않는다 — 내보낸 폴더는 Argo 보호(게이트·동기화
// EXCLUDE) 밖이라, 담는 순간 평문 유출 경로가 된다. 제외 목록은 exportExcluded가 정본이고
// (secretbox.mjs isSecretRel과 동일 3종 + 금고 도트파일), 테스트가 잠근다. 목적지 검증은
// workroots.mjs의 validateWorkRoot를 재사용한다(절대경로·존재·디렉토리·보호 구역 거부·realpath 봉인).
//
// 복사기는 fs.cp가 아니라 수동 워커다(분리 검수 2026-07-28 반영):
//  - 심링크는 복사하지 않는다 — 이름만 보는 제외 목록을 우회해 자격을 가리키는 "살아있는 포인터"가
//    사본에 실리는 것(MED-1)과, 대상이 실체화되지 않았는데 개수에 잡히는 거짓 안심을 함께 차단.
//  - copyFile은 fs.cp와 달리 원본 mode를 chmod로 복원하지 않는다 — exFAT/FAT 외장 드라이브에서
//    chmod EPERM으로 중간 사망하는 함정 제거(검수 7 — 이 기능의 대상이 정확히 외장 드라이브다).
//  - .partial에 복사 후 성공 시 rename — 부분 실패 잔재가 완전한 백업으로 오인되지 않는다(MED-2).
import { copyFile, readdir, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { validateWorkRoot } from './workroots.mjs';

const err = (code, msg) => Object.assign(new Error(msg), { code });

/** 내보내기 제외 판정(순수) — rel = 워크스페이스 루트 기준 '/' 구분 상대경로.
    (export: 회귀 테스트용 — 이 목록이 곧 보안 계약이다) */
export const exportExcluded = (rel) => {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  // 워크스페이스 직속 도트 항목 = 금고 — .secrets.json(러너 자격)·.workroots.json·기기 상태·게이트웨이 큐 등.
  // 한 단계 아래 도트 경로(chats/.archive 등)는 정상 데이터라 통과(권한 게이트와 같은 경계).
  if (parts.length === 1 && base.startsWith('.')) return true;
  if (parts.length === 1 && (base === 'connections.json' || base === 'mcp.json')) return true; // 메신저 봇 토큰·MCP env 토큰
  if (base.startsWith('.tmp-') || base.includes('.corrupt-')) return true; // 원자쓰기 임시·손상 백업(잡음)
  if (base === '.DS_Store') return true;
  return false;
};

/** 재귀 복사 — 심링크·비정규 파일 제외, 제외 목록 적용, 복사하며 집계. */
async function copyTree(srcDir, dstDir, relBase, state) {
  await mkdir(dstDir, { recursive: true });
  for (const e of await readdir(srcDir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (exportExcluded(rel)) continue;
    if (e.isSymbolicLink()) continue; // 심링크 미복사 — 자격 포인터·거짓 집계 차단(검수 MED-1)
    const sp = join(srcDir, e.name);
    const dp = join(dstDir, e.name);
    if (e.isDirectory()) { await copyTree(sp, dp, rel, state); continue; }
    if (!e.isFile()) continue; // 소켓·fifo 등 비정규 파일
    await copyFile(sp, dp); // mode 복원 없음 — exFAT 외장에서 chmod EPERM 함정 제거(검수 7)
    state.files += 1;
  }
}

/** 회사 워크스페이스를 destDir 아래 argo-export-<ws>-<ts>/ 로 복사. 반환 { target, files }. */
export async function exportCompany(wsId, destDir) {
  const src = paths(wsId).root; // paths()가 wsId 형식·경계를 검증한다
  if (!existsSync(src)) throw err('no-company', wsId); // 목적지 부재(not-found)와 구분 — 안내가 갈린다(검수 6)
  const dest = await validateWorkRoot(destDir); // 목적지 검증 재사용 — 보호 구역·루트 전체 거부 포함
  const target = join(dest, `argo-export-${wsId}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  if (existsSync(target)) throw err('exists', target); // 같은 초 재실행 — 사용자 재시도로 해소
  const tmp = `${target}.partial`;
  const state = { files: 0 };
  try {
    await copyTree(src, tmp, '', state);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {}); // 부분 잔재 정리 — 잘린 백업의 무음 생존 방지
    throw err('copy-failed', String(e.message || e));
  }
  await rename(tmp, target); // 성공 시에만 정식 이름 — 원자 rename 관용구(jsonstore와 동일 계열, 검수 MED-2)
  return { target, files: state.files };
}
