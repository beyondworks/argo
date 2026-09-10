// 모바일 전용 변경 게이트 — 데스크톱에 스타일이 새는 것을 기계적으로 막는다(유건 지시 2026-09-10).
// 기본 기준은 HEAD(= 지금부터의 새 변경만 검사). 다른 기준은 인자로: node scripts/mobile-only-guard.mjs origin/main
//
// 모바일 안전 구역 세 가지(실측으로 확인한 이 레포의 구조):
//   ① @media … max-width: 720px         — 폰 폭
//   ② @media … pointer: coarse          — 터치 기기(가로 폰·짧은 뷰포트)
//   ③ .msgr-short-viewport 선택자        — mobile-viewport.js가 (isMobilePlatform || pointer:coarse)일 때만 붙인다
// 데스크톱 Argo 앱과 공유하는 app/ 아래는 통째로 금지(app/globals.css = 디자인 시스템 정본, 사본 금지).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SHEET = 'apps/messenger/src/styles.css';
const base = process.argv[2] ?? 'HEAD';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const changed = git('diff', '--name-only', base).split('\n').filter(Boolean);
const problems = [];
const notes = [];

for (const f of changed.filter((f) => f.startsWith('app/'))) {
  problems.push(`${f} — 데스크톱 Argo 앱과 공유하는 자리다. 모바일 작업에서 건드리지 않는다`);
}

// styles.css: 모바일 미디어쿼리 블록 구간을 중괄호 깊이로 구한다.
function mobileRanges(text) {
  const ranges = [];
  let depth = 0, start = -1, atDepth = 0;
  text.split('\n').forEach((line, i) => {
    const at = line.match(/@media([^{]*)/);
    if (start === -1 && at && /max-width:\s*720px|pointer:\s*coarse/.test(at[1])) { start = i + 1; atDepth = depth; }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (start !== -1 && depth <= atDepth) { ranges.push([start, i + 1]); start = -1; }
  });
  return ranges;
}

if (changed.includes(SHEET)) {
  const ranges = mobileRanges(readFileSync(SHEET, 'utf8'));
  const safe = (n, text) => ranges.some(([a, b]) => n >= a && n <= b) || text.includes('msgr-short-viewport');
  const diff = git('diff', '-U0', base, '--', SHEET).split('\n');
  let newLine = 0;
  for (const line of diff) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { newLine = Number(h[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const body = line.slice(1);
    if (line.startsWith('+')) {
      if (body.trim() && !safe(newLine, body)) problems.push(`${SHEET}:${newLine} 모바일 구역 밖 추가 — 데스크톱에도 적용된다: ${body.trim().slice(0, 70)}`);
      newLine += 1;
    } else if (line.startsWith('-') && body.trim()) {
      if (!safe(newLine, body)) problems.push(`${SHEET}:~${newLine} 모바일 구역 밖 삭제 — 데스크톱에도 영향: ${body.trim().slice(0, 70)}`);
    }
  }
}

// 구조(JSX) 변경은 미디어쿼리가 막아주지 않는다 — 의식적으로 승인할 때만 통과시킨다.
const jsx = changed.filter((f) => f.endsWith('.jsx') || (f.startsWith('apps/messenger/src/') && f.endsWith('.js')));
if (jsx.length && process.env.MOBILE_GUARD_ALLOW_JSX !== '1') {
  problems.push(`구조 변경 ${jsx.length}건(${jsx.join(', ')}) — 데스크톱 메신저에도 그려진다. 모바일 전용 분기를 확인한 뒤 MOBILE_GUARD_ALLOW_JSX=1로 통과시킨다`);
} else if (jsx.length) notes.push(`구조 변경 ${jsx.length}건은 승인 통과(MOBILE_GUARD_ALLOW_JSX=1)`);

if (problems.length) { console.error('모바일 전용 게이트 실패:\n' + problems.map((p) => ` - ${p}`).join('\n')); process.exit(1); }
console.log(`모바일 전용 게이트 통과 (기준 ${base}, 변경 ${changed.length}건)${notes.length ? '\n' + notes.map((n) => ` · ${n}`).join('\n') : ''}`);
