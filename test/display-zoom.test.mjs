// 표시 배율 행동 테스트 — 부트 절반(layout.jsx zoomBoot)과 조절 절반(i18n.jsx adjustZoom).
// 둘 다 소스에서 추출해 실제로 실행한다(vm). adjustZoom은 전역 단축키(cmd +·−·0)와
// 설정 화면 버튼이 공유하는 단일 로직이라, 여기 행동이 곧 두 진입점의 행동이다.
// 레이아웃 비례 유지·실클릭 왕복은 실브라우저 검증(Aside — 분리 검수 절차).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const layout = readFileSync(join(ROOT, 'app', 'layout.jsx'), 'utf8');

function extractBoot() {
  const m = layout.match(/const zoomBoot = `([^`]+)`/);
  assert.ok(m, 'layout.jsx에 zoomBoot 부트 스크립트가 있어야 한다');
  return m[1];
}

function runBoot({ innerWidth, savedZoom }) {
  // setProperty 구현 — 실제 CSSOM처럼 커스텀 프로퍼티(--z)를 받아야 부트 후반(zoom 설정)까지
  // 관측된다(검수 지적: 평범한 객체면 TypeError를 부트의 catch가 삼켜 뒤가 전부 무게이트).
  const props = {};
  const style = { setProperty: (k, v) => { props[k] = String(v); }, removeProperty: (k) => { delete props[k]; } };
  const ctx = {
    window: { innerWidth },
    localStorage: { getItem: () => (savedZoom == null ? null : String(savedZoom)) },
    document: { documentElement: { style } },
    parseFloat,
  };
  ctx.window.localStorage = ctx.localStorage;
  vm.runInNewContext(extractBoot(), ctx);
  return { zoom: style.zoom, z: props['--z'], auto: ctx.window.__argoAutoZoom };
}

test('일반 화면(1800px 미만)은 배율 미설정 — 기존 레이아웃과 완전 동일', () => {
  for (const w of [1280, 1440, 1728, 1799]) {
    assert.equal(runBoot({ innerWidth: w }).zoom, undefined, `${w}px`);
  }
});

test('큰 모니터 자동 배율 — 1800↑ 1.2, 2400↑(QHD) 1.5, 3400↑(4K) 1.7', () => {
  assert.equal(runBoot({ innerWidth: 1800 }).zoom, 1.2);
  assert.equal(runBoot({ innerWidth: 2399 }).zoom, 1.2);
  assert.equal(runBoot({ innerWidth: 2400 }).zoom, 1.5);
  assert.equal(runBoot({ innerWidth: 3399 }).zoom, 1.5);
  assert.equal(runBoot({ innerWidth: 3400 }).zoom, 1.7);
  assert.equal(runBoot({ innerWidth: 3840 }).zoom, 1.7);
});

test('배율 적용 시 100vh 보정 변수(--z)도 같은 값으로 — zoom만 걸리면 전체 화면 레이아웃이 넘친다', () => {
  const r = runBoot({ innerWidth: 2500 });
  assert.equal(r.zoom, 1.5);
  assert.equal(r.z, '1.5');
  assert.equal(runBoot({ innerWidth: 1280 }).z, undefined, '배율 1 = 보정 변수도 미설정');
});

test('저장값(cmd +/- 조절분)이 자동 판정보다 우선한다', () => {
  assert.equal(runBoot({ innerWidth: 1280, savedZoom: 1.3 }).zoom, 1.3);
  assert.equal(runBoot({ innerWidth: 3840, savedZoom: 1 }).zoom, undefined, '저장 1.0 = 미설정과 동일');
});

test('손상·범위 밖 저장값은 자동 판정으로 관용한다', () => {
  for (const bad of ['abc', '0', '0.3', '9', '-1']) {
    assert.equal(runBoot({ innerWidth: 1280, savedZoom: bad }).zoom, undefined, `저장값 ${bad}`);
    assert.equal(runBoot({ innerWidth: 2500, savedZoom: bad }).zoom, 1.5, `저장값 ${bad} + 큰 화면`);
  }
});

test('cmd+0 리셋이 재사용할 자동 판정 함수를 전역에 남긴다', () => {
  const { auto } = runBoot({ innerWidth: 1280 });
  assert.equal(typeof auto, 'function');
  assert.equal(auto(), 1);
});

test('layout이 zoomBoot를 첫 페인트 전 스크립트로 배선한다', () => {
  assert.match(layout, /__html:\s*zoomBoot/, 'zoomBoot가 인라인 스크립트로 주입돼야 한다');
});

// ---- adjustZoom(i18n.jsx) — 단축키·설정 버튼 공용 조절 로직 ----

const i18n = readFileSync(join(ROOT, 'app', 'i18n.jsx'), 'utf8');
const settings = readFileSync(join(ROOT, 'app', 'c', '[ws]', 'settings', 'page.jsx'), 'utf8');

function extractAdjust() {
  const m = i18n.match(/export (function adjustZoom\(delta\) \{[\s\S]*?\n\})/);
  assert.ok(m, 'i18n.jsx에 adjustZoom 공용 함수가 있어야 한다');
  return m[1];
}

function runAdjust(delta, { styleZoom = '', auto, saved } = {}) {
  const ops = []; const props = {}; const store = {}; const events = [];
  if (saved != null) store['argo-zoom'] = String(saved);
  let zoomVal = styleZoom;
  const style = {
    setProperty: (k, v) => { props[k] = String(v); ops.push(`set:${k}`); },
    removeProperty: (k) => { delete props[k]; ops.push(`rm:${k}`); },
  };
  Object.defineProperty(style, 'zoom', { get: () => zoomVal, set: (v) => { zoomVal = v; ops.push('zoom'); } });
  const ctx = {
    document: { documentElement: { style } },
    window: { dispatchEvent: (e) => events.push(e.type) },
    localStorage: { setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    Event: class { constructor(type) { this.type = type; } },
  };
  if (auto !== undefined) ctx.window.__argoAutoZoom = () => auto;
  const ret = vm.runInNewContext(`${extractAdjust()}; adjustZoom(${delta});`, ctx);
  return { ret, zoom: zoomVal, z: props['--z'], store, ops, events };
}

test('adjustZoom 10% 단계 — zoom·--z·저장값 동시 갱신', () => {
  const r = runAdjust(0.1);
  assert.equal(r.ret, 1.1);
  assert.equal(r.zoom, '1.1');
  assert.equal(r.z, '1.1');
  assert.equal(r.store['argo-zoom'], '1.1');
});

test('adjustZoom 부동소수 안전 — 1.1에서 한 단계 올리면 정확히 1.2', () => {
  const r = runAdjust(0.1, { styleZoom: '1.1' });
  assert.equal(r.ret, 1.2);
  assert.equal(r.zoom, '1.2');
});

test('adjustZoom 클램프 — 단축키와 같은 0.7~2.0 경계', () => {
  assert.equal(runAdjust(0.1, { styleZoom: '2' }).ret, 2);
  assert.equal(runAdjust(-0.1, { styleZoom: '0.7' }).ret, 0.7);
});

test('adjustZoom(null) 리셋 — 자동 판정 복귀 + 저장 삭제', () => {
  const r = runAdjust(null, { styleZoom: '1.6', auto: 1.25, saved: 1.6 });
  assert.equal(r.ret, 1.25);
  assert.equal(r.zoom, '1.25');
  assert.equal(r.z, '1.25');
  assert.equal(r.store['argo-zoom'], undefined, '리셋은 저장값을 지워 자동 판정으로 돌아간다');
});

test('배율 1 도달 — 스타일 완전 제거(미설정 렌더와 동일)', () => {
  const r = runAdjust(-0.1, { styleZoom: '1.1' });
  assert.equal(r.ret, 1);
  assert.equal(r.zoom, '');
  assert.equal(r.z, undefined);
  const reset = runAdjust(null, { styleZoom: '1.3', saved: 1.3 });
  assert.equal(reset.ret, 1, '자동 판정 함수 부재 시 리셋은 1로 관용');
  assert.equal(reset.zoom, '');
});

test('--z 먼저, zoom 나중 — 중간 실패가 넘침(확대+무보정)이 되지 않는 순서', () => {
  const { ops } = runAdjust(0.1);
  assert.ok(ops.indexOf('set:--z') !== -1 && ops.indexOf('set:--z') < ops.indexOf('zoom'), `순서: ${ops.join(',')}`);
});

test('adjustZoom이 argo:zoom 이벤트로 알린다 — 설정 카드 현재값 동기화 채널', () => {
  assert.deepEqual(runAdjust(0.1).events, ['argo:zoom']);
});

test('배선 — 단축키·설정 버튼 둘 다 adjustZoom 하나를 탄다(로직 두 벌 금지)', () => {
  // 표현식 전체를 앵커 — 접두만 잠그면 부호 뒤집기(−가 확대)가 그물을 통과한다(분리 검수 MEDIUM 실증)
  assert.match(i18n, /adjustZoom\(e\.key === '0' \? null : e\.key === '-' \? -0\.1 : 0\.1\)/, '키 핸들러의 키→delta 매핑(0=리셋·−=축소·나머지=확대)');
  assert.equal(i18n.split("setProperty('--z'").length - 1, 1, '--z 쓰기는 i18n.jsx 안에서 adjustZoom 한 벌이어야 한다');
  assert.match(settings, /import \{[^}]*adjustZoom[^}]*\} from '\.\.\/\.\.\/\.\.\/i18n'/, '설정 화면이 공용 함수를 임포트');
  assert.match(settings, /adjustZoom\(-0\.1\)/, '축소 버튼');
  assert.match(settings, /adjustZoom\(0\.1\)/, '확대 버튼');
  assert.match(settings, /adjustZoom\(null\)/, '자동(리셋) 버튼');
  assert.ok(!settings.includes("setProperty('--z'"), '설정 화면이 배율을 직접 쓰면 안 된다(공용 함수 경유)');
  assert.match(settings, /addEventListener\('argo:zoom'/, '단축키 변경도 카드 표시가 따라와야 한다');
  assert.match(settings, /removeEventListener\('argo:zoom'/, '언마운트 시 리스너 해제(등록 핀과 짝)');
});

test('사전 — 표시 배율 문구 ko/en 등록 + 설정 카드가 전부 사전 경유', () => {
  for (const key of ['settings.zoom', 'settings.zoom.desc', 'settings.zoom.out', 'settings.zoom.in', 'settings.zoom.auto', 'settings.zoom.shortcut']) {
    const m = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}': \\['([^']+)', '([^']+)'\\]`));
    assert.ok(m, `${key} ko/en 등록`);
    assert.notEqual(m[1], m[2], `${key}는 ko·en이 달라야 한다(en 미번역 방지 — 이 6키엔 고유명사 예외 없음)`);
    assert.ok(settings.includes(`t('${key}')`), `${key}를 설정 카드가 사용`);
  }
});
