// 표시 배율(zoomBoot) 행동 테스트 — 큰 모니터 자동 스케일 + cmd +/-/0 수동 배율의 부트 절반.
// layout.jsx의 zoomBoot 문자열을 실제로 실행해(vm) 자동 판정·저장값·관용을 검증한다.
// 키 핸들러(i18n.jsx)와 레이아웃 비례 유지는 실브라우저 검증(Aside — 분리 검수 절차).
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

test('큰 모니터 자동 배율 — 1800px 이상 1.1, 2400px 이상 1.25', () => {
  assert.equal(runBoot({ innerWidth: 1800 }).zoom, 1.1);
  assert.equal(runBoot({ innerWidth: 2399 }).zoom, 1.1);
  assert.equal(runBoot({ innerWidth: 2400 }).zoom, 1.25);
  assert.equal(runBoot({ innerWidth: 3840 }).zoom, 1.25);
});

test('배율 적용 시 100vh 보정 변수(--z)도 같은 값으로 — zoom만 걸리면 전체 화면 레이아웃이 넘친다', () => {
  const r = runBoot({ innerWidth: 2500 });
  assert.equal(r.zoom, 1.25);
  assert.equal(r.z, '1.25');
  assert.equal(runBoot({ innerWidth: 1280 }).z, undefined, '배율 1 = 보정 변수도 미설정');
});

test('저장값(cmd +/- 조절분)이 자동 판정보다 우선한다', () => {
  assert.equal(runBoot({ innerWidth: 1280, savedZoom: 1.3 }).zoom, 1.3);
  assert.equal(runBoot({ innerWidth: 3840, savedZoom: 1 }).zoom, undefined, '저장 1.0 = 미설정과 동일');
});

test('손상·범위 밖 저장값은 자동 판정으로 관용한다', () => {
  for (const bad of ['abc', '0', '0.3', '9', '-1']) {
    assert.equal(runBoot({ innerWidth: 1280, savedZoom: bad }).zoom, undefined, `저장값 ${bad}`);
    assert.equal(runBoot({ innerWidth: 2500, savedZoom: bad }).zoom, 1.25, `저장값 ${bad} + 큰 화면`);
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
