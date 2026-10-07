// 테스트 임시 디렉터리 위생 — mkdtemp 드롭인 + 러너 CLI 조달 차단 스텁.
//
// [왜] 테스트들이 격리 ARGO_ROOT/HOME을 mkdtemp로 만들고 지우지 않아 $TMPDIR에 argo-* 잔여물이
// 누적됐다(2026-08-30 실측: 18,908개·115.3GB). 특히 격리 HOME에서 saveRunnerCred를 부르는
// 파일(runner-cred·runner-connected-truth)은 워밍업 조달이 실행당 ~360MB를 새로 내려받았다.
//
// [어떻게] node --test는 테스트 파일당 자식 프로세스 1개다 — 프로세스 exit 훅이 곧 파일 단위
// teardown이라, 이 모듈의 mkdtemp로 만든 디렉터리는 실패·조기 종료를 포함해 종료 시 일괄 삭제된다.
// SIGINT/SIGTERM(Ctrl-C·러너 중단)도 exit로 승격해 같은 청소를 태운다. SIGKILL만 잔여물을 남긴다.
import { mkdtemp as fsMkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const created = [];
process.once('exit', () => {
  // exit 핸들러는 동기만 실행된다 — rmSync. 삭제 실패는 무해(OS 임시 정리가 이어받는다).
  for (const dir of created) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 무해 */ }
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(1));

/** node:fs/promises.mkdtemp와 시그니처 동일 — 만든 디렉터리를 exit 삭제 대상으로 등록만 추가. */
export async function mkdtemp(prefix) {
  const dir = await fsMkdtemp(prefix);
  created.push(dir);
  return dir;
}

/** 격리 HOME에 러너 관리본 스텁을 심어 CLI 조달(실물 다운로드)을 차단한다.
    saveRunnerCred('codex'|'gemini')는 연결 워밍업으로 provisionCodexCli/provisionGeminiCli를
    발화하는데, 두 조달 모두 관리본이 "존재하면" 즉시 반환한다(src/runners/codex.mjs·gemini.mjs
    첫 분기) — 빈 파일이면 충분하다. 자격 배관만 검증하고 CLI를 실행하지 않는 테스트 전용.
    경로 계약: codexManagedBin()·geminiManagedEntry()와 동일 경로 — 제품 경로가 바뀌면 조달이
    재개될 뿐(구 동작 복귀 + exit 청소는 유지)이라 조용히 깨지지 않는다.
    codex 관리본은 핀마다 폴더가 따로라(codexToolDirFor) 제품 함수로 경로를 받는다. 스탬프(.pin)까지 심어 설치 완료 상태로 둔다 —
    스탬프가 없으면 턴이 host 보강 내려받기를 시도한다. 호출 전에 HOME이 정해져 있어야 한다(codex.mjs가 로드 시 homedir()로 경로를 고정). */
export async function stubRunnerToolDirs(home = process.env.HOME) {
  const { codexToolDirFor, CODEX_PIN } = await import('../../src/runners/codex.mjs');
  const codexDir = codexToolDirFor(home);
  const geminiBundle = join(home, '.argo', 'tools', 'gemini-cli', 'package', 'bundle');
  await mkdir(codexDir, { recursive: true });
  await mkdir(geminiBundle, { recursive: true });
  await writeFile(join(codexDir, process.platform === 'win32' ? 'codex.exe' : 'codex'), '');
  await writeFile(join(codexDir, '.pin'), CODEX_PIN);
  await writeFile(join(geminiBundle, 'gemini.js'), '');
}
