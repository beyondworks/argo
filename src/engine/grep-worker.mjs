// Grep 워커(네이티브 엔진) — 정규식 검색을 워커 스레드에서 돌린다. 이유(분리 검수 MEDIUM-4 실측): `(a+)+$` 같은
// 백트래킹 패턴이 앱 서버 이벤트 루프를 통째로 멈췄다(915ms 동안 타이머 1회). 워커는 terminate()로 끊을 수 있어
// 시간 상한·정지 버튼이 성립한다. 이 파일은 단독 모듈이다(부모와 순환 import 없음).
// 심링크는 따라가지 않는다(재검수 NEW-HIGH-1: vault/x -> .secrets.json·~/.claude 디렉터리 심링크로 자격 실유출 — rg 기본값과 같은 계약).
import { parentPort, workerData } from 'node:worker_threads';
import { readFile, stat, lstat, realpath, glob as fsGlob } from 'node:fs/promises';
import { resolve, relative, sep, matchesGlob } from 'node:path';

const SKIP_DIR_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
const posix = (p) => String(p).split(sep).join('/');

(async () => {
  try {
    const { root, pattern, flags, glob, mode, headLimit } = workerData;
    const re = new RegExp(pattern, flags);
    const rootAbs = resolve(root);
    const rootReal = await realpath(rootAbs).catch(() => rootAbs);
    // 루트 봉쇄는 **실경로** 기준(2중 방어 — 분리 검수 CRITICAL-1·NEW-HIGH-1): 렉시컬 resolve는 심링크를 못 본다
    const insideReal = async (abs) => { const r = await realpath(abs).catch(() => null); return !!r && (r === rootReal || r.startsWith(rootReal + sep)); };
    const files = [];
    const st = await stat(rootAbs).catch(() => null);
    if (st?.isFile()) files.push(rootAbs);
    else {
      // glob은 **패턴 자리에 넣지 않는다** — 루트 상대 경로 필터로만(rg 계약 복원). 패턴 자리에 두면 `../.secrets.json`·절대경로가
      // 곧 열거 경로가 된다(분리 검수 CRITICAL-1: 금고·타사·홈 자격 실유출).
      for await (const f of fsGlob('**/*', { cwd: rootAbs, exclude: (p) => SKIP_DIR_RE.test(p) })) {
        const abs = resolve(rootAbs, f);
        const ls = await lstat(abs).catch(() => null);
        if (!ls || ls.isSymbolicLink() || !ls.isFile()) continue; // 심링크 항목은 건너뛴다(파일·디렉터리 모두 — rg 기본 미추종)
        if (!(await insideReal(abs))) continue; // 심링크 디렉터리 아래로 하강한 항목은 실경로가 루트 밖이다
        const rel = posix(f);
        if (glob && !matchesGlob(rel, glob)) continue;
        files.push(abs);
      }
    }
    const lines = []; const hits = [];
    for (const f of files) {
      const s = await stat(f).catch(() => null); if (!s?.isFile() || s.size > 2_000_000) continue;
      const txt = await readFile(f, 'utf8').catch(() => null); if (txt == null) continue;
      const rel = posix(relative(rootAbs, f) || f);
      let c = 0;
      txt.split('\n').forEach((line, i) => { if (re.test(line)) { c += 1; if (mode === 'content' && lines.length < headLimit) lines.push(`${rel}:${i + 1}:${line}`); } });
      if (c) hits.push({ f: rel, c });
    }
    let text;
    if (mode === 'files_with_matches') text = hits.slice(0, headLimit).map((h) => h.f).join('\n');
    else if (mode === 'count') text = hits.slice(0, headLimit).map((h) => `${h.f}:${h.c}`).join('\n');
    else text = lines.join('\n');
    parentPort.postMessage({ ok: true, text: text || '(no matches)' });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message || e) });
  }
})();
