// Grep 워커(네이티브 엔진) — 정규식 검색을 워커 스레드에서 돌린다. 이유(분리 검수 MEDIUM-4 실측): `(a+)+$` 같은
// 백트래킹 패턴이 앱 서버 이벤트 루프를 통째로 멈췄다(915ms 동안 타이머 1회). 워커는 terminate()로 끊을 수 있어
// 시간 상한·정지 버튼이 성립한다. 이 파일은 단독 모듈이다(부모와 순환 import 없음).
import { parentPort, workerData } from 'node:worker_threads';
import { readFile, stat, glob as fsGlob } from 'node:fs/promises';
import { resolve, relative, sep, matchesGlob } from 'node:path';

const SKIP_DIR_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
const posix = (p) => String(p).split(sep).join('/');

(async () => {
  try {
    const { root, pattern, flags, glob, mode, headLimit } = workerData;
    const re = new RegExp(pattern, flags);
    const rootAbs = resolve(root);
    // 루트 봉쇄(2중 방어 — 분리 검수 CRITICAL-1): 열거된 항목이 무슨 이유로든 root 밖이면 버린다
    const inside = (f) => { const a = resolve(rootAbs, f); return a === rootAbs || a.startsWith(rootAbs + sep); };
    const files = [];
    const st = await stat(rootAbs).catch(() => null);
    if (st?.isFile()) files.push(rootAbs);
    else {
      // glob은 **패턴 자리에 넣지 않는다** — 루트 상대 경로 필터로만(rg 계약 복원). 패턴 자리에 두면 `../.secrets.json`·절대경로가
      // 곧 열거 경로가 된다(분리 검수 CRITICAL-1: 금고·타사·홈 자격 실유출).
      for await (const f of fsGlob('**/*', { cwd: rootAbs, exclude: (p) => SKIP_DIR_RE.test(p) })) {
        if (!inside(f)) continue;
        const rel = posix(f);
        if (glob && !matchesGlob(rel, glob)) continue;
        files.push(resolve(rootAbs, f));
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
