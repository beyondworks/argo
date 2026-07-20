// 러너 표시 하드코딩 트립와이어 — "전수 수색을 기억해서 돌린다"는 방식이 하루에 두 번 실패한 날
// (2026-07-20: #57 capabilities 누락 → 규칙 제정 → 같은 날 명판 'Claude Agent SDK' 하드코딩이
// 고객 신고로 재발) 만든 기계 게이트. 사람이 기억할 필요 없이 npm test마다 돈다.
//
// 원칙: 러너 표시 이름의 원천은 src/runners.mjs의 RUNNERS 하나다. UI 코드에 러너명 리터럴
// 폴백이 들어오는 순간 "실제 연결과 무관한 표시"가 생기고, 그건 전부 고객 신고로 돌아왔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 주석 제거(라인 기준 근사) — 트립와이어 용도라 정밀 파서 불요. 문자열 안의 //는 이 파일이 잡는
    패턴(러너명 리터럴)과 겹치지 않아 오탐 영향 없음. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => {
    const i = l.indexOf('//');
    return i === -1 ? l : l.slice(0, i);
  }).join('\n');

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
};

// [패턴, 설명, 허용 파일(정확 일치)] — 허용은 "정의의 원천"뿐. 늘리고 싶어지면 그게 바로 표류 신호다.
const BANNED = [
  [/(['"`])Claude Agent SDK\1/, "엔진 라벨 하드코딩 — 실제 연결 러너는 usableRunnerNames로", []],
  [/\?\?\s*(['"`])Claude Code\1/, "러너명 폴백 하드코딩 — 미지정은 '자동'으로 표시", []],
  [/\|\|\s*(['"`])claude\1/, "러너 id 기본값 하드코딩 — '' = 자동(서버 pickRunner)", []],
  [/id:\s*(['"`])claude\1\s*,\s*name:\s*(['"`])Claude Code\2/, '가짜 카탈로그 폴백 — 로딩 중엔 빈 목록 + disabled', ['src/runners.mjs']],
];

test('러너 표시 하드코딩 금지 — 원천은 RUNNERS 하나 (기억 아닌 기계가 검사)', () => {
  const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'src'))];
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const [re, why, allow] of BANNED) {
      if (allow.includes(rel)) continue;
      const m = code.match(re);
      if (m) hits.push(`${rel}: ${m[0]} — ${why}`);
    }
  }
  assert.deepEqual(hits, [], `러너 표시 하드코딩 검출:\n${hits.join('\n')}`);
});
