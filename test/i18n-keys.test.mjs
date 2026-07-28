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

/** 소스에서 **정적으로 확정되는** t() 키만 수집한다.
    제외 대상은 접미가 런타임 값이라 정적으로 풀 수 없는 것들이다 — 템플릿(t(`a.${b}`))과
    변수 전달(t(key)). "폴백이라서 뺀다"가 아니다(재검수 지적: 폴백 관용구는 변수 형태 쪽이고,
    템플릿은 오히려 폴백 없이 그대로 렌더된다 — 그건 별도 후속 과제).
    삼항은 **리터럴이므로 검사한다**: t(x ? 'a' : 'b')는 출고된 버그와 같은 모양인데
    첫 판에선 그물 밖이었다(재검수 MEDIUM-1, 변이로 실증). 2번째 인자의 보간 값에 오탐이
    나지 않도록 "t( 안의 모든 리터럴"을 긁지 않고 삼항 형태만 좁게 집는다. */
function literalKeys(src) {
  const keys = [];
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) keys.push(m[1]);
  for (const m of src.matchAll(/\bt\([^'"`)]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) keys.push(m[1], m[2]);
  return keys;
}

test('t()에 넘기는 리터럴 키는 전부 사전에 있다', () => {
  const dict = loadDict();
  const missing = [];
  for (const file of walk(APP)) {
    // 사전 파일도 검사한다 — 자기 사전으로 자기 t() 호출을 보는 건 오히려 정확하다(재검수 LOW-4:
    // 제외하면 i18n.jsx 안의 실제 t() 호출 1곳이 그물 밖으로 샌다).
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
