// i18n 키 정합 트립와이어 — 사전에 없는 키를 t()에 넘기면 화면에 **키 문자열이 그대로** 나온다.
//
// 실사고 2026-07-28: 옵시디언 임포트 카드가 t('settings.export.browse')를 참조했는데 그 키가
// 사전에 없어, 버튼 라벨이 "settings.export.browse"로 출고됐다(유건 신고, v0.1.32 화면).
// 같은 페이지의 내보내기 카드는 common.browse를 쓰고 있었으니 오타가 아니라 **없는 키를 지어낸**
// 것이다 — 리뷰로는 잘 안 걸리고, 렌더해 보기 전엔 조용하다.
//
// 프로젝트 상시 규칙(CLAUDE.md): 모든 UI 문자열은 app/i18n.jsx 사전을 경유하고 ko/en 둘 다
// 등록한다. 그 규칙을 사람 규율이 아니라 npm test로 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, 'app');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 사전 파싱 — `'key': ['ko', 'en'],` 형태만 본다(DICT 정의부의 실제 형식). */
function loadDict() {
  const src = readFileSync(join(APP, 'i18n.jsx'), 'utf8');
  const dict = new Map();
  for (const m of src.matchAll(/^\s*'([^']+)':\s*\[/gm)) dict.set(m[1], m.index);
  return dict;
}

/** 소스에서 t('리터럴') 호출만 수집. 템플릿 리터럴(t(`a.${b}`))은 동적이라 제외 —
    코드가 의도적으로 "없으면 폴백"(mapped === key) 관용구로 쓰는 자리가 그쪽이다. */
function literalKeys(src) {
  const keys = [];
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) keys.push(m[1]);
  return keys;
}

test('t()에 넘기는 리터럴 키는 전부 사전에 있다', () => {
  const dict = loadDict();
  const missing = [];
  for (const file of walk(APP)) {
    if (file.endsWith(`${'i18n'}.jsx`)) continue; // 사전 자신은 제외
    for (const k of literalKeys(readFileSync(file, 'utf8'))) {
      if (!dict.has(k)) missing.push(`${relative(ROOT, file)} → t('${k}')`);
    }
  }
  assert.deepEqual(missing, [], `사전에 없는 키(화면에 원문 노출):\n${missing.join('\n')}`);
});

test('사전의 모든 항목은 ko·en 두 값을 가진다', () => {
  const src = readFileSync(join(APP, 'i18n.jsx'), 'utf8');
  const bad = [];
  // 값 배열의 원소 수를 센다 — 문자열 안의 쉼표에 속지 않도록 따옴표 단위로 토큰을 센다.
  // 따옴표는 두 종류 다 받는다: 영문 값이 어포스트로피를 담으면 "..."로 쓰는 게 정상 형식이다.
  for (const m of src.matchAll(/^\s*'([^']+)':\s*\[([\s\S]*?)\],?\s*$/gm)) {
    const items = m[2].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) ?? [];
    if (items.length !== 2) bad.push(`${m[1]} (값 ${items.length}개)`);
  }
  assert.deepEqual(bad, [], `ko/en 쌍이 아닌 항목:\n${bad.join('\n')}`);
});
