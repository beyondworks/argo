// UM1(2026-10-05 분리 검수): '새 소식' 칩·'새로 고침 실패' 칩이 좁은 폭에서 상단바를 넘쳤다 —
// ① 칩이 생기거나 사라져도 상자 크기는 그대로라 ResizeObserver가 안 돌고 fitBar가 다시 측정하지 않았다(561 en: 상단바 21px·문서 13px 넘침, 접기 속성 없음)
// ② '새 소식'은 tasks.running이 blocked에 들어 있어 턴마다 칩이 사라졌다 생겼다(그때마다 폭이 바뀐다).
// 잠그는 행동(브라우저 없이): 상단바 안의 자식 변화를 관찰해 재측정을 부르는 배선(watchTopbarContent), 안내 차단 판정(updateNotesBlocked).
// 접기 CSS 자체(라벨 숨김)와 실제 넘침 0은 측정으로 확인한다 — display-zoom-layout.test.mjs의 배선 핀 + 폭별 측정 캡처.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchTopbarContent } from '../app/c/[ws]/topbar-fit.mjs';
import { updateNotesBlocked } from '../app/update-notes-state.mjs';

class FakeObserver {
  static last = null;
  constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; FakeObserver.last = this; }
  observe(target, options) { this.observed.push([target, options]); }
  disconnect() { this.disconnected = true; }
}

test('상단바 안의 자식(칩·배지)이 생기거나 사라지면 재측정을 부른다 — 상자 크기가 안 변해도', () => {
  const bar = { id: 'bar' };
  let fits = 0;
  const stop = watchTopbarContent(bar, () => { fits++; }, { MutationObserverImpl: FakeObserver });
  const mo = FakeObserver.last;
  assert.equal(mo.observed.length, 1);
  assert.equal(mo.observed[0][0], bar, '상단바를 관찰한다');
  assert.deepEqual(mo.observed[0][1], { childList: true, subtree: true }, '자식 추가·제거(칩은 포털로도 들어온다)만 — 속성 변화는 보지 않아 접기 속성 토글이 되먹임하지 않는다');
  mo.cb([{ type: 'childList' }]);
  assert.equal(fits, 1);
  stop();
  assert.equal(mo.disconnected, true);
});

test('상단바가 없거나 관찰기가 없는 환경은 조용히 건너뛴다', () => {
  assert.equal(typeof watchTopbarContent(null, () => {}, { MutationObserverImpl: FakeObserver }), 'function');
  assert.equal(typeof watchTopbarContent({}, () => {}, { MutationObserverImpl: undefined }), 'function');
});

test('안내 칩은 턴이 도는 동안에도 사라지지 않는다 — 실행 중 턴은 차단 조건이 아니다', () => {
  const base = { data: { company: {} }, tasks: { running: [] }, dockOpen: false, fbOpen: false, renameTeam: null, updPhase: 'idle' };
  assert.equal(updateNotesBlocked(base), false);
  assert.equal(updateNotesBlocked({ ...base, tasks: { running: [{ slug: 'a' }] } }), false, '실행 중 턴이 있어도 칩은 그대로(턴마다 폭이 바뀌어 상단바가 흔들리던 것)');
  for (const patch of [{ data: null }, { data: { missing: true } }, { data: { loadError: true } }, { tasks: null }, { dockOpen: true }, { fbOpen: true }, { renameTeam: 'x' }, { updPhase: 'checking' }, { updPhase: 'installing' }, { updPhase: 'ready' }]) {
    assert.equal(updateNotesBlocked({ ...base, ...patch }), true, JSON.stringify(patch));
  }
  assert.equal(updateNotesBlocked({ ...base, renameTeam: '' }), true, '빈 문자열 팀 이름 입력 중도 열린 입력창이다');
});

// 2차 분리 검수 M1·L3(2026-10-05): 칩 라벨이 시계·버전 숨김과 같은 단계에서 접혀, 자리가 남아도 '새로 고침 실패' 글이 사라졌다
// (크루 대화 1100 ko: 오른쪽 약 250px이 비는데 칩은 25px 점 / 960 en 칩 둘: 약 530px 비는데 두 칩 모두 점).
// → 접기를 단계로: 시계·버전 숨김 → 새 소식 칩 라벨 접기 → 오류 칩 라벨 접기(가장 늦게) → 슬롯을 밴드로(이때 칩 라벨은 다시 펼칠 수 있는 만큼 펼친다). 매 단계 다시 잰다.
// L3: over()가 scrollWidth + 1을 허용해 끝 패딩 침범(0.9px)을 못 봤다 → 마지막 자식의 오른쪽이 바 content-box 오른쪽 안인지로도 판정한다.
import { TOPBAR_STAGES, fitTopbar, isTopbarOver } from '../app/c/[ws]/topbar-fit.mjs';

/** 가짜 문서 루트 + 폭 모델 — 단계별 절약 폭을 빼고 사용 가능 폭과 비교한다(실제 CSS가 하는 일의 모사 — 실제 값은 측정 캡처로 확인). */
function model({ need, avail, saves = { bar: 120, notes: 80, error: 130, shell: 400 }, unfoldShellRestores = true }) {
  const attrs = new Set();
  const root = { setAttribute: (a) => attrs.add(a), removeAttribute: (a) => attrs.delete(a) };
  const width = () => {
    let w = need;
    if (attrs.has('data-narrow-bar')) w -= saves.bar;
    if (attrs.has('data-narrow-notes')) w -= saves.notes;
    if (attrs.has('data-narrow-error')) w -= saves.error;
    if (attrs.has('data-narrow-shell')) w -= saves.shell;
    return w;
  };
  return { root, attrs, over: () => width() > avail };
}
const flagsOf = (attrs) => [...attrs].map((a) => a.replace('data-narrow-', '')).sort();

test('단계 순서 — 시계·버전 → 새 소식 라벨 → 오류 라벨(가장 늦게) → 슬롯 밴드', () => {
  assert.deepEqual(TOPBAR_STAGES.slice(0, 4), [[], ['bar'], ['bar', 'notes'], ['bar', 'notes', 'error']]);
  assert.ok(TOPBAR_STAGES.slice(4).every((s) => s.includes('shell')), '슬롯 밴드는 칩 라벨을 다 접어도 모자랄 때만');
  const idx = (f) => TOPBAR_STAGES.findIndex((s) => s.join() === f.join());
  assert.ok(idx(['bar', 'notes']) < idx(['bar', 'notes', 'error']), '오류 칩이 새 소식 칩보다 늦게 접힌다');
});

test('M1: 시계·버전만 접으면 들어가는 폭에서는 칩 라벨이 그대로 보인다(1100 ko 재현: 칩 라벨 161px이 들어갈 자리가 있는데 점이던 것)', () => {
  const m = model({ need: 1000, avail: 900 }); // bar 120 접으면 880 ≤ 900
  assert.deepEqual(flagsOf((fitTopbar(m.root, m.over), m.attrs)), ['bar']);
});

test('칩 라벨은 필요한 만큼만 접는다 — 새 소식 먼저, 오류 칩은 가장 늦게', () => {
  let m = model({ need: 1000, avail: 790 }); // bar 120 + notes 80 = 800 > 790? → 1000-200 = 800 > 790 → 오류까지
  fitTopbar(m.root, m.over);
  assert.deepEqual(flagsOf(m.attrs), ['bar', 'error', 'notes']);
  m = model({ need: 1000, avail: 800 }); // 1000-120-80 = 800 ≤ 800 → 새 소식만
  fitTopbar(m.root, m.over);
  assert.deepEqual(flagsOf(m.attrs), ['bar', 'notes'], '오류 칩 라벨은 아직 펼쳐 둔다');
});

test('M1: 슬롯 밴드로 내려 자리가 생기면 칩 라벨을 다시 펼친다(960 en 재현: 슬롯이 숨은 뒤 약 530px이 비는데 두 칩이 점이던 것)', () => {
  const m = model({ need: 1400, avail: 900 }); // A단계는 전부 모자람(1400-330=1070>900), shell 400 → 1400-120-400 = 880 ≤ 900
  const picked = fitTopbar(m.root, m.over);
  assert.deepEqual(flagsOf(m.attrs), ['bar', 'shell'], '밴드로 내려 들어가면 칩 라벨은 접지 않는다');
  assert.deepEqual(picked, ['bar', 'shell']);
  const tight = model({ need: 1400, avail: 600 }); // 모든 단계를 접어도 670 > 600 — 가장 접힌 단계에 둔다
  fitTopbar(tight.root, tight.over);
  assert.deepEqual(flagsOf(tight.attrs), ['bar', 'error', 'notes', 'shell'], '그래도 모자라면 가장 접힌 단계에 둔다');
});

test('넓으면 아무것도 접지 않는다 — 매번 가장 넓은 상태에서 다시 시작해 래칫이 없다', () => {
  const m = model({ need: 1000, avail: 900 });
  fitTopbar(m.root, m.over);
  assert.deepEqual(flagsOf(m.attrs), ['bar']);
  const wide = model({ need: 1000, avail: 1200 });
  wide.attrs.add('data-narrow-bar'); wide.attrs.add('data-narrow-shell'); // 직전에 접혀 있던 상태
  fitTopbar(wide.root, wide.over);
  assert.deepEqual(flagsOf(wide.attrs), [], '넓어지면 모두 펼쳐진다');
});

/** isTopbarOver용 가짜 바 — 자식의 오른쪽 좌표·표시 방식·상자 비율(배율)을 지정한다 */
function fakeBar({ scrollWidth = 500, clientWidth = 500, left = 0, offsetWidth = clientWidth, paddingRight = 22, scale = 1, children }) {
  const rectOf = (l, w) => ({ left: l, right: l + w, width: w, height: w ? 34 : 0 });
  const mk = (k) => ({ ...k, getBoundingClientRect: () => rectOf(k.left ?? 0, k.width ?? 0), children: (k.children ?? []).map(mk) });
  return {
    scrollWidth, clientWidth, offsetWidth,
    getBoundingClientRect: () => rectOf(left, offsetWidth * scale),
    children: children.map(mk),
    __paddingRight: paddingRight,
  };
}
const style = (el) => (el.__paddingRight !== undefined ? { paddingRight: `${el.__paddingRight}px`, borderRightWidth: '0px', display: 'flex' } : { display: el.display ?? 'block' });

test('L3: scrollWidth가 안 넘쳐도 마지막 자식이 오른쪽 패딩을 침범하면 넘침이다(960 en: 검색칸이 0.9px 화면 밖)', () => {
  // 바 폭 500, 오른쪽 패딩 22 → content-box 오른쪽 478. 검색칸 오른쪽 478.9 → 넘침
  assert.equal(isTopbarOver(fakeBar({ children: [{ left: 380, width: 98.9 }] }), style), true);
  assert.equal(isTopbarOver(fakeBar({ children: [{ left: 380, width: 98 }] }), style), false, '딱 맞으면 넘침이 아니다');
  assert.equal(isTopbarOver(fakeBar({ children: [{ left: 380, width: 98.4 }] }), style), false, '서브픽셀 반올림 여유 0.5px 안');
  assert.equal(isTopbarOver(fakeBar({ scrollWidth: 520, children: [{ left: 380, width: 98 }] }), style), true, '기존 판정(scrollWidth)도 그대로');
});

test('L3: 숨은 자식(display none)·크기 0·display: contents 칩 자리는 건너뛰고 실제 마지막 자식으로 판정한다 — 배율이 있어도', () => {
  const bar = fakeBar({ children: [
    { left: 300, width: 100 },
    { display: 'contents', children: [{ left: 410, width: 68 }] }, // 칩이 든 contents 래퍼 — 안쪽 칩이 마지막 실제 자식
    { display: 'none', left: 480, width: 50 },
    { display: 'block', left: 480, width: 0 },
  ] });
  assert.equal(isTopbarOver(bar, (el) => (el.display ? { display: el.display } : style(el))), false);
  const scaled = fakeBar({ scale: 1.25, offsetWidth: 400, clientWidth: 400, scrollWidth: 400, paddingRight: 20, children: [{ left: 300, width: 200 }] }); // 상자 500(=400×1.25), 패딩 20×1.25=25 → content 오른쪽 475, 자식 오른쪽 500 → 넘침
  assert.equal(isTopbarOver(scaled, style), true, '배율이 있으면 패딩도 같은 비율로 환산한다');
  const scaledOk = fakeBar({ scale: 1.25, offsetWidth: 400, clientWidth: 400, scrollWidth: 400, paddingRight: 20, children: [{ left: 300, width: 175 }] });
  assert.equal(isTopbarOver(scaledOk, style), false);
});
