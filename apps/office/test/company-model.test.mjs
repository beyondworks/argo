import test from 'node:test';
import assert from 'node:assert/strict';
import { guessKey, companyProfile, groupItems, itemPayload, moveInCategory, DOC_KEYS, CATEGORY_FROM_KO } from '../src/core/company-model.js';
import { filterPeople, counts, personPayload, linkable, agentLabel } from '../src/core/people-model.js';
import { autoTotal, scoreTone, radarPoints, versionsOf, filterEvals, trendOf, trendPath, subjectsOf, evalPayload, parsePeriod, currentOnly } from '../src/core/eval-model.js';
import { parseMarkdown, inline } from '../src/core/markdown.js';
import { NAV, VIEWS, NAV_ICON, readNav } from '../src/core/nav-model.js';

// 트랙 C(유건 10/2): 인트라넷 회사 정보·직원·인사고과를 오피스로. 견적·계약 서식(트랙 A)이 회사 정보를 읽는다.
const it = (label, value, extra = {}) => ({ id: label, label, value, category: 'basic', key: null, ...extra });

test('회사 정보 서식 값: key가 붙은 항목 먼저, 없으면 항목 이름으로 짐작 — 계좌는 계좌 분류 전부', () => {
  const items = [it('상호', '(주)A', { key: 'name' }), it('대표 이사', '김대표'), it('사업자 번호', '123'), it('대표자', '이름짐작'), it('주거래', '국민 1', { category: 'bank' }), it('예비', '', { category: 'bank' })];
  const p = companyProfile(items);
  assert.equal(p.name, '(주)A');
  assert.equal(p.ceo, '김대표', '공백을 무시한 "대표이사"');
  assert.equal(p.bizNo, '123');
  assert.deepEqual(p.accounts, [{ label: '주거래', value: '국민 1' }], '빈 계좌는 빼고');
  assert.ok(p.missing.includes('address') && !p.missing.includes('name'));
  assert.deepEqual(companyProfile([]).missing, DOC_KEYS, '빈 회사는 서식 칸 전부가 빈 칸');
  assert.deepEqual(companyProfile(null).accounts, []);
  // 도장·로고(트랙 A 계약서) — 그림 주소만, 그림이 아니면 빈 값
  const img = companyProfile([it('회사 도장', 'data:image/png;base64,AAAA', { key: 'seal' }), it('로고', 'javascript:x', { key: 'logo' })]);
  assert.deepEqual([img.seal, img.logo], ['data:image/png;base64,AAAA', '']);
  assert.equal(itemPayload({ label: '도장', key: 'seal', value: 'data:image/png;base64,' + 'A'.repeat(5000) }).value.length, 22 + 5000, '그림은 2,000자에서 자르지 않는다');
});

test('항목 이름 짐작은 전체가 같을 때만(부분 일치로 엉뚱한 칸에 들어가지 않게)', () => {
  assert.equal(guessKey('사업장 소재지'), 'address');
  assert.equal(guessKey('E-mail'), 'email');
  assert.equal(guessKey('상호(법인명)'), 'name');
  assert.equal(guessKey('상호 변경 이력'), null);
  assert.equal(guessKey(''), null);
  assert.deepEqual(Object.values(CATEGORY_FROM_KO), ['basic', 'bank', 'contact', 'tax', 'other']);
});

test('분류 묶기·순서 옮기기·저장 입력 정리', () => {
  const items = [it('a', '1'), it('b', '2', { category: 'bank' }), it('c', '3'), it('d', '4', { category: 'weird' })];
  assert.deepEqual(groupItems(items).map((g) => [g.category, g.items.map((x) => x.id)]), [['basic', ['a', 'c']], ['bank', ['b']], ['other', ['d']]], '모르는 분류는 기타(인트라넷 미분류)');
  assert.deepEqual(moveInCategory(items, 'c', -1), ['c', 'a']);
  assert.equal(moveInCategory(items, 'a', -1), null, '맨 위는 못 올린다');
  assert.equal(itemPayload({ label: '  ' }), null);
  assert.deepEqual(itemPayload({ id: 'x', label: ' 팩스 ', value: ' 02 ', category: 'nope', key: 'fax' }), { id: 'x', label: '팩스', value: '02', notes: '', category: 'other', key: 'fax' });
  assert.equal(itemPayload({ label: 'x', key: 'evil' }).key, null);
});

test('직원 명부: 상태·검색, 입력 정리(퇴사일이 입사일보다 이르면 막기), 연결할 계정 후보', () => {
  const people = [{ id: '1', name: '최민지', title: '디자이너', status: 'active', user_id: 'u1' }, { id: null, name: '한지호', status: 'active', user_id: 'u2' }, { id: '3', name: '이하은', status: 'left', email: 'h@x' }];
  assert.deepEqual(filterPeople(people).map((p) => p.name), ['최민지', '한지호']);
  assert.deepEqual(filterPeople(people, { status: 'all', q: '디자' }).map((p) => p.name), ['최민지']);
  assert.deepEqual(filterPeople(people, { status: 'left', q: 'H@X' }).map((p) => p.name), ['이하은']);
  assert.deepEqual(counts(people), { active: 2, left: 1, all: 3 });
  assert.equal(personPayload({ name: '' }), null);
  assert.equal(personPayload({ name: 'a', joined_on: '2026-05-01', left_on: '2026-04-01' }), null);
  assert.deepEqual(personPayload({ id: 'p', name: ' 박 ', joined_on: 'bad', user_id: '' }), { id: 'p', name: '박', title: '', department: '', email: '', phone: '', agent: '', joined_on: null, left_on: null, notes: '', user_id: null });
  assert.deepEqual(linkable(people, 'u1').map((p) => p.user_id), ['u1', 'u2'], '지금 연결된 계정 + 명부 없는 계정');
  assert.deepEqual(linkable(people, null).map((p) => p.user_id), ['u2']);
  assert.equal(agentLabel('claude'), 'Claude Code'); assert.equal(agentLabel('hermes:hyona'), 'Hermes · hyona');
});

const ev = (id, extra = {}) => ({ id, subject_kind: 'person', subject_user: 'u1', subject_name: '최민지', subject_type: 'staff', scope: 'month', period_from: '2026-08-01', period_to: '2026-08-31', total: 70, replaces: null, replaced_by: null, created_at: `2026-09-0${id.length}T00:00:00Z`, ...extra });

test('평가 점수: 종합점수 평균·색 단계(인트라넷과 같은 80/60 경계)·레이더 꼭짓점', () => {
  assert.equal(autoTotal({ performance: 80, quality: 70, productivity: '', expertise: null, collaboration: 91 }), 80);
  assert.equal(autoTotal({}), null);
  assert.deepEqual([scoreTone(80), scoreTone(79), scoreTone(60), scoreTone(59), scoreTone(null)], ['good', 'mid', 'mid', 'low', 'none']);
  const pts = radarPoints({ performance: 100, quality: 0 }, 100);
  assert.deepEqual(pts[0], [0, -100], '첫 항목은 12시 방향');
  assert.deepEqual(pts[1], [0, 0], '0점은 가운데');
  assert.equal(pts.length, 5);
});

test('평가 판: 새 판이 생기면 목록에는 지금 판만, 판 목록은 첫 판 → 지금 판', () => {
  const list = [ev('a', { replaced_by: 'bb' }), ev('bb', { replaces: 'a', replaced_by: 'ccc' }), ev('ccc', { replaces: 'bb', total: 90 }), ev('dddd', { subject_kind: 'crew', subject_user: null, subject_name: '루나', subject_type: 'agent', scope: 'year', period_from: '2025-01-01', period_to: '2025-12-31' })];
  assert.deepEqual(currentOnly(list).map((e) => e.id), ['ccc', 'dddd']);
  assert.deepEqual(versionsOf(list, 'bb').map((e) => e.id), ['a', 'bb', 'ccc']);
  assert.deepEqual(filterEvals(list, { scope: 'year' }).map((e) => e.id), ['dddd']);
  assert.deepEqual(filterEvals(list, { subject: 'crew:루나' }).map((e) => e.id), ['dddd']);
  assert.deepEqual(subjectsOf(list).map((s) => s.name), ['루나', '최민지']);
});

test('평가 추이: 같은 대상·같은 범위의 지금 판만 기간 순서로, 세로 눈금은 점수 범위에 맞춘다', () => {
  const list = [ev('j', { period_from: '2026-07-01', total: 72 }), ev('a', { total: 76 }), ev('s', { period_from: '2026-09-01', total: 81 }), ev('w', { scope: 'week', total: 10 }), ev('o', { subject_user: 'u2', total: 5 })];
  assert.deepEqual(trendOf(list, list[1]).map((p) => p.total), [72, 76, 81]);
  const xy = trendPath(trendOf(list, list[1]), 100, 50, 0);
  assert.equal(xy[0][0], 0); assert.equal(xy[2][0], 100);
  assert.ok(xy[0][1] > xy[1][1] && xy[1][1] > xy[2][1], '점수가 오르면 위로');
  assert.deepEqual(trendPath([], 10, 10), []);
});

test('평가 쓰기 입력: 대상·기간·제목이 있어야 하고, 새 판은 원래 판을 가리킨다', () => {
  const period = { from: '2026-09-01', to: '2026-09-30' };
  assert.equal(evalPayload({ id: 'x', title: '', scope: 'month', subject_kind: 'person', subject_user: 'u1' }, period), null);
  assert.equal(evalPayload({ id: 'x', title: 't', scope: 'month', subject_kind: 'person', subject_user: '' }, period), null);
  const p = evalPayload({ id: 'x', title: 't', scope: 'month', subject_kind: 'person', subject_user: 'u1', performance: '101', quality: '7.6' }, period);
  assert.deepEqual([p.performance, p.quality, p.from, p.to, p.subject_type], [100, 8, '2026-09-01', '2026-09-30', 'staff']);
  assert.equal(evalPayload({ id: 'x', title: 't', scope: 'week', subject_kind: 'crew', subject_name: ' 루나 ' }, period).subject_name, '루나');
  const v = evalPayload({ id: 'y', title: 't2', replaces: 'x', total: '90' }, null);
  assert.deepEqual([v.replaces, v.total, v.scope], ['x', 90, undefined]);
});

test('인트라넷 기간 글 읽기(이관)', () => {
  assert.deepEqual(parsePeriod('2026-09-07 ~ 09-13', 'week'), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(parsePeriod('2026.08.03~2026.08.09', 'week'), { from: '2026-08-03', to: '2026-08-09' });
  assert.deepEqual(parsePeriod('2026년 9월', 'month'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(parsePeriod('2025', 'year'), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(parsePeriod('9월 2주차', 'week', '2026-09-10'), { from: '2026-09-07', to: '2026-09-13' }, '못 읽으면 기준 날짜의 주(월~일)');
});

test('마크다운: 제목·목록·표·인용·굵게·코드 — HTML 문자열 없이 조각으로', () => {
  const b = parseMarkdown('## 총평\n**좋음** 이고 `코드`\n\n- 하나\n- 둘\n\n| a | b |\n| --- | :-: |\n| 1 | **2** |\n\n> 인용\n1. 첫째');
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'ul', 'table', 'quote', 'ol']);
  assert.equal(b[0].level, 2);
  assert.deepEqual(inline('**좋음** 이고 `코드`').map((x) => x.t), ['bold', 'text', 'code']);
  assert.equal(b[3].rows[0][1][0].t, 'bold');
  assert.deepEqual(parseMarkdown('<script>x</script>')[0].lines[0], [{ t: 'text', v: '<script>x</script>' }], '태그는 글자 그대로');
});

test('왼쪽 메뉴: 조직 공간에 직원·회사 정보(성과 기록 앞), 내 공간에는 없다', () => {
  assert.ok(NAV.org.indexOf('people') < NAV.org.indexOf('company') && NAV.org.indexOf('company') < NAV.org.indexOf('perf'));
  assert.ok(!NAV.me.includes('people') && !NAV.me.includes('company'));
  assert.ok(VIEWS.includes('people') && VIEWS.includes('company'));
  assert.equal(NAV_ICON.company, 'building');
  // 예전에 저장한 메뉴 순서에도 새 메뉴가 바로 앞 메뉴 뒤에 끼어 나온다
  const shown = readNav([{ id: 'home' }, { id: 'docs' }, { id: 'perf' }], 'org').shown;
  assert.deepEqual(shown.slice(shown.indexOf('docs'), shown.indexOf('docs') + 4), ['docs', 'people', 'company', 'perf']);
});
