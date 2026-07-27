// 회사 데이터 내보내기 — 사장이 지정한 폴더로 회사 워크스페이스를 통째로 복사한다(백업·이사·보관).
//
// 배경(2026-07-28 유건 제품 판단): A갈래 신고(데이터를 외장 SSD·다른 드라이브로, 4건/4명)에 대해
// 위치 변경(Rust 수정·데이터 이동이 걸린 고위험)보다 저위험한 내보내기를 먼저 출하한다.
// 크루에게 시키는 추출은 외부 작업 폴더(workroots)로 회사 단위는 이미 가능하지만, "자격 제외가
// 보장된 표준 경로"는 앱 기능이어야 한다 — 크루는 타사 데이터 금지구역이라 전체 추출도 불가.
//
// 보안(불변): 자격·시크릿을 담는 파일은 복사하지 않는다 — 내보낸 폴더는 Argo 보호(게이트·동기화
// EXCLUDE) 밖이라, 담는 순간 평문 유출 경로가 된다. 제외 목록은 exportExcluded가 정본이고
// 테스트가 잠근다. 목적지 검증은 workroots.mjs의 validateWorkRoot를 재사용한다(절대경로·존재·
// 디렉토리·앱 루트/~/.argo/WS_ROOT 거부·realpath 봉인 — 워크스페이스 "안으로" 내보내기도 막힌다).
import { cp, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
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

/** 회사 워크스페이스를 destDir 아래 argo-export-<ws>-<ts>/ 로 복사. 반환 { target, files }. */
export async function exportCompany(wsId, destDir) {
  const src = paths(wsId).root; // paths()가 wsId 형식·경계를 검증한다
  if (!existsSync(src)) throw err('not-found', wsId);
  const dest = await validateWorkRoot(destDir); // 목적지 검증 재사용 — 보호 구역·루트 전체 거부 포함
  const target = join(dest, `argo-export-${wsId}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
  if (existsSync(target)) throw err('exists', target); // 같은 초 재실행 — 사용자 재시도로 해소
  const srcPrefix = `${src}${sep}`;
  await cp(src, target, {
    recursive: true,
    filter: (p) => {
      if (p === src) return true;
      const rel = p.slice(srcPrefix.length).split(sep).join('/');
      return !exportExcluded(rel);
    },
  });
  // 파일 수 집계 — "몇 개 복사됐는지"가 사용자에게 완료의 실감이다(빈 결과의 무음 방지)
  let files = 0;
  async function count(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await count(join(dir, e.name));
      else files += 1;
    }
  }
  await count(target);
  return { target, files };
}
