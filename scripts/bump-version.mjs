// 릴리스 버전 4파일 동시 범프 — 릴리스마다 손으로 4파일을 고치던 세금(최근 300커밋에서 파일당
// 32~38회 터치)과 반쪽 범프 사고를 제거한다(안정화 프로그램 G007).
//
// 사용:
//   node scripts/bump-version.mjs 0.1.32     # 4파일을 0.1.32로 범프(사전 일치 검증 포함)
//   node scripts/bump-version.mjs --check    # 4파일 버전 일치만 검증(CI·발행 드릴용, 불일치=exit 1)
//
// 4파일: package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml / src-tauri/Cargo.lock
// Cargo.lock 함정(실사고 2026-07-26, v0.1.26 드릴): 수백 개 크레이트 중 우리 앱 크레이트의 이름은
// 디렉토리명이 아니라 **"app"** 이다 — [[package]] name = "app" 블록의 version만 갈아야 하고,
// 같은 버전 문자열을 가진 다른 크레이트를 건드리면 안 된다(블록 앵커 정규식으로 한정).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 주의: Cargo.lock 앵커의 리터럴 \n은 레포 .gitattributes(`* text=auto eol=lf`)가 전 플랫폼 LF
// 체크아웃을 보장하는 데 의존한다 — 그 줄이 지워지면 Windows에서 이 정규식만 조용히 깨진다.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** 4파일의 현재 버전 읽기 — { file: version } (export: 테스트용, root 주입 가능) */
export async function readVersions(root = process.cwd()) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const conf = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const toml = await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const lock = await readFile(join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const tomlV = toml.match(/^version = "([^"]+)"/m)?.[1] ?? null;
  const lockV = lock.match(/\[\[package\]\]\nname = "app"\nversion = "([^"]+)"/)?.[1] ?? null;
  return {
    'package.json': pkg.version ?? null,
    'src-tauri/tauri.conf.json': conf.version ?? null,
    'src-tauri/Cargo.toml': tomlV,
    'src-tauri/Cargo.lock': lockV,
  };
}

/** 4파일 일치 검증 — 일치하면 그 버전, 아니면 throw(어느 파일이 다른지 명시). */
export async function checkVersions(root = process.cwd()) {
  const v = await readVersions(root);
  const values = [...new Set(Object.values(v))];
  if (values.length !== 1 || values[0] === null) {
    throw new Error(`버전 불일치: ${Object.entries(v).map(([f, x]) => `${f}=${x}`).join(' / ')}`);
  }
  return values[0];
}

/** 범프 — 사전 일치 검증 → 4파일 교체 → 사후 재검증. 앱 크레이트 블록만 한정 교체. */
export async function bumpVersions(next, root = process.cwd()) {
  if (!SEMVER_RE.test(next)) throw new Error(`버전 형식 오류(x.y.z): ${next}`);
  const cur = await checkVersions(root); // 반쪽 범프 상태에서 겹쳐 쓰지 않는다 — 먼저 정합 확인
  if (cur === next) throw new Error(`이미 ${next} — 범프할 것이 없습니다`);

  const pkgPath = join(root, 'package.json');
  const confPath = join(root, 'src-tauri', 'tauri.conf.json');
  const tomlPath = join(root, 'src-tauri', 'Cargo.toml');
  const lockPath = join(root, 'src-tauri', 'Cargo.lock');

  // JSON 2종은 텍스트 치환 — JSON.stringify 재직렬화는 포맷·키 순서를 흔들어 diff를 오염시킨다
  await writeFile(pkgPath, (await readFile(pkgPath, 'utf8')).replace(`"version": "${cur}"`, `"version": "${next}"`));
  await writeFile(confPath, (await readFile(confPath, 'utf8')).replace(`"version": "${cur}"`, `"version": "${next}"`));
  await writeFile(tomlPath, (await readFile(tomlPath, 'utf8')).replace(new RegExp(`^version = "${cur.replace(/\./g, '\\.')}"`, 'm'), `version = "${next}"`));
  await writeFile(lockPath, (await readFile(lockPath, 'utf8')).replace(
    `[[package]]\nname = "app"\nversion = "${cur}"`,
    `[[package]]\nname = "app"\nversion = "${next}"`,
  ));

  const after = await checkVersions(root); // 사후 재검증 — 하나라도 안 갈렸으면 여기서 불일치로 잡힌다
  if (after !== next) throw new Error(`범프 사후 검증 실패: ${after} !== ${next}`);
  return { from: cur, to: next };
}

// CLI 진입 — import 시(테스트)는 실행하지 않는다.
// pathToFileURL 필수(분리 검수 필수 지적): 문자열 결합 `file://${argv[1]}`은 Windows 드라이브·
// 공백 경로에서 import.meta.url과 어긋나 CLI가 **무발화 exit 0** — CI 게이트가 있는 척만 하게 된다.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  try {
    if (arg === '--check') {
      const v = await checkVersions();
      // 태그 대조 모드(검수 권고 1): --check v0.1.32 — 태그와 파일 버전이 어긋나면 모든 기기가
      // 영구 업데이트 루프(설치해도 버전 그대로라 계속 제안)에 빠진다. 태그 경로에서 필수.
      const expected = process.argv[3]?.replace(/^v/, '');
      if (expected && expected !== v) throw new Error(`태그-파일 버전 불일치: 태그=${expected}, 파일=${v}`);
      console.log(`버전 일치: ${v} (4파일${expected ? ` + 태그 대조` : ''})`);
    } else if (arg) {
      const { from, to } = await bumpVersions(arg);
      console.log(`범프 완료: ${from} → ${to} (4파일)`);
      console.log('다음: git diff 확인 → 커밋 → 태그 푸시(v' + to + ') 또는 workflow_dispatch');
    } else {
      console.error('사용: node scripts/bump-version.mjs <x.y.z> | --check');
      process.exit(2);
    }
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
