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

// 사전 항목 정규식 — 후행 주석(`], // …`·`], /* … */`)을 허용한다. 옛 형태(`\],?\s*$`)는 후행
// 주석 항목에서 lazy 매치가 다음 줄까지 삼켜, 그 항목이 값 오판 red가 나는 데 그치지 않고
// **바로 다음 항목이 검사 대상에서 통째로 빠졌다**(ko/en 누락을 조용히 놓치는 fail-open —
// 2026-08-30 PR #354 검수 실측; 블록 주석도 같은 기전 — #360 검수 조건 2).
// 알려진 한계(#360 검수 조건 1 — 아래 '알려진 한계' 테스트가 실행 문서): 값 문자열 **안에**
// `], //`류가 들어 있는 병적 항목은 조기 종결되는데, 그 앞의 완결 토큰 수에 따라 방향이 갈린다 —
// 값 2개(정상 형식)면 0개로 오판돼 red(fail-closed)지만, 값 3개 이상(형식 위반)이면 앞의 2개만
// 세어져 **통과할 수 있다**(옛 정규식은 3개로 적발했다 — 이 병적 형태에 한해 탐지력 후퇴).
const DICT_ENTRY_RE = /^\s*'([^']+)':\s*\[([\s\S]*?)\],?\s*(?:\/\/.*|\/\*.*)?$/gm;

/** 사전 소스 → [키, 값 개수] 목록(순수) — 실사전 검사와 아래 픽스처 회귀 단언이 같은 코드를 쓴다.
    값 개수는 따옴표 토큰 단위로 센다 — 문자열 안의 쉼표에 속지 않고, 어포스트로피를 담은 영문
    값이 "..."로 쓰인 정상 형식도 받는다. */
function scanDictEntries(src) {
  const out = [];
  for (const m of src.matchAll(DICT_ENTRY_RE)) {
    const items = m[2].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) ?? [];
    out.push([m[1], items.length]);
  }
  return out;
}

test('사전의 모든 항목은 ko·en 두 값을 가진다', () => {
  const src = readFileSync(join(APP, 'i18n.jsx'), 'utf8');
  const bad = scanDictEntries(src).filter(([, n]) => n !== 2).map(([k, n]) => `${k} (값 ${n}개)`);
  assert.deepEqual(bad, [], `ko/en 쌍이 아닌 항목:\n${bad.join('\n')}`);
});

test('검사기: 후행 주석 항목도, 바로 다음 항목도 검사한다 (PR #354 fail-open 회귀 핀)', () => {
  // 옛 정규식의 실측 결함 재현 픽스처 — 첫 항목의 후행 주석이 lazy 매치를 다음 줄로 끌고 가면
  // 키 목록에서 'a.second'가 사라지고(검사 누락), 'a.first'는 값 4개로 오판됐다.
  const fixture = [
    "  'a.first': ['하나', 'one'], // 후행 주석",
    "  'a.second': ['둘'],",
    "  'a.third': ['셋', 'three'],",
  ].join('\n');
  const entries = scanDictEntries(fixture);
  assert.deepEqual(entries.map(([k]) => k), ['a.first', 'a.second', 'a.third'],
    '후행 주석이 다음 항목을 검사에서 빼놓으면 ko/en 누락을 조용히 놓친다');
  assert.deepEqual(entries, [['a.first', 2], ['a.second', 1], ['a.third', 2]],
    '후행 주석 항목은 값 2개로 옳게 세고, 다음 항목의 누락(값 1개)은 그대로 적발돼야 한다');
});

test('검사기: 후행 블록 주석(/* */)도 같은 기전 — 다음 항목이 삼켜지지 않는다 (#360 검수 조건 2)', () => {
  const fixture = [
    "  'b.first': ['하나', 'one'], /* 블록 주석 */",
    "  'b.second': ['둘', 'two'],",
  ].join('\n');
  assert.deepEqual(scanDictEntries(fixture), [['b.first', 2], ['b.second', 2]],
    '블록 주석 항목이 오판되거나 다음 항목이 스캔에서 빠지면 안 된다');
});

test('검사기 알려진 한계: 값 안의 "], //"는 완결 토큰 수에 따라 방향이 갈린다 (#360 검수 조건 1 — 실행 문서)', () => {
  // 값 2개(정상 형식) + 첫 값 안에 함정 → 조기 종결로 0개 오판 = red(fail-closed — 거짓 경보지만 안전한 방향)
  assert.deepEqual(scanDictEntries("  'p.two': ['x ], // 함정', 'y'],"), [['p.two', 0]],
    '정상 2값 항목의 값 내 함정은 거짓 경보(red)로 드러난다 — 조용히 통과하지 않는다');
  // 값 3개(형식 위반 — 이 검사가 잡아야 할 대상) + 셋째 값 안에 함정 → 앞의 2개만 세어져 **통과**.
  // 옛 정규식은 3개로 적발했다 — 이 병적 형태에 한해 탐지력이 후퇴함을 실행 문서로 박아둔다:
  // 이 단언이 red가 되면(정규식을 다시 만졌다면) 한계 서술과 방향이 함께 갱신돼야 한다.
  assert.deepEqual(scanDictEntries("  'p.three': ['x', 'y', 'z ], // 함정'],"), [['p.three', 2]],
    '3값+값 내 함정은 현 정규식이 2개로 세어 통과한다 — 문서화된 한계(자연스러운 후행 주석 전체를 고치는 대가)');
});
