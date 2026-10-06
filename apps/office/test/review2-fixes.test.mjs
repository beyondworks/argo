// 10/5 분리 검수 남은 3건 + 사전 키 충돌 — 플러그인 배정 중복, 서버에 없는 페이지의 머리줄, 개인 1:1로 가는 글의 '@' 후보, docs.empty 두 뜻.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as A from '../src/core/crew-assign.js';
import { t } from '../src/core/i18n.js';

// 내 공간의 한 줄 = 같은 에이전트의 조직 행 둘 + 개인 행(crew-list.js oneEach) — 대표는 o1
const pepper = { id: 'o1', ids: ['o1', 'o2', 'tw'], name: '페퍼' };
const wolf = { id: 'w1', name: '울프' };

// 이유(분리 검수 LOW, 데이터 중복): 내 공간 플러그인 편집에서 대표가 아닌 행 id(o2)로 예전에 배정한 플러그인이 체크 안 된 것으로 보이고,
// 대표를 다시 체크하면 같은 에이전트에 두 번 들어갔다
test('플러그인 배정: 묶인 행 어느 id로 배정돼 있어도 체크로 보이고, 다시 저장해도 그 에이전트 배정은 1개', () => {
  assert.ok(A.toolCrewOn && A.toggleToolCrew && A.oncePerAgent, '배정 판정 함수가 있어야 한다');
  assert.equal(A.toolCrewOn(['o2'], pepper), true, '비대표 행 배정도 체크');
  assert.equal(A.toolCrewOn(['x'], pepper), false);
  assert.equal(A.toolCrewOn(['w1'], wolf), true, '묶이지 않은 줄은 그 id');
  assert.deepEqual(A.toggleToolCrew(['o2', 'x'], pepper), ['x'], '끄면 묶인 행 id를 모두 뺀다(모르는 id는 그대로)');
  assert.deepEqual(A.toggleToolCrew(['x'], pepper), ['x', 'o1'], '켜면 대표 id 하나');
  assert.deepEqual(A.oncePerAgent(['o2'], [pepper, wolf]), ['o2'], '그대로 저장 — 1개');
  assert.deepEqual(A.oncePerAgent(['o2', 'o1', 'w1', 'tw', 'x'], [pepper, wolf]), ['o2', 'w1', 'x'], '이미 두 번 들어간 것은 처음 것만, 목록에 없는 id는 지우지 않는다');
});

// 같은 흐름(맡길 때 배정된 플러그인을 글에 싣는다): 서버 crew.tools는 크루 id 하나만 본다 — 묶인 줄은 행마다 물어 합친다
test('맡길 때 플러그인: 같은 에이전트의 행마다 물어 합치고(같은 플러그인은 한 번), 한 행을 못 읽어도 나머지는 싣는다', async () => {
  assert.ok(A.crewTools && A.agentIds, 'crewTools·agentIds가 있어야 한다');
  const asked = [];
  const got = await A.crewTools(A.agentIds(pepper, []), async (id) => { asked.push(id); if (id === 'tw') throw new Error('down'); return id === 'o1' ? [{ id: 't1' }] : [{ id: 't1' }, { id: 't2' }]; });
  assert.deepEqual(asked, ['o1', 'o2', 'tw']);
  assert.deepEqual(got.map((x) => x.id), ['t1', 't2']);
  // 조직 공간의 에이전트 상세에서 열면 고른 행에 ids가 없다(화면 확인 10/5) — 같은 묶음 키(agent)의 행을 찾는다(사본·꺼진 행 빼고)
  const rows = [{ id: 'o2', agent: 'P' }, { id: 'o1', agent: 'P' }, { id: 'tw', agent: 'P', personal: true }, { id: 'cp', agent: 'P', copy: true }, { id: 'off', agent: 'P', access: 'inactive' }, { id: 'w1', agent: 'W' }];
  assert.deepEqual(A.agentIds(rows[0], rows), ['o2', 'o1', 'tw']);
  assert.deepEqual(A.agentIds(wolf, []), ['w1'], '묶음 키가 없으면 그 행 하나');
});

// 이유(분리 검수 LOW, 확인): 맡기기 '@' 후보는 조직 크루인데 글은 개인 1:1로 간다. 개인 방의 동료는 그 방에 든 크루뿐이다
// (서버 msgr_crew_context: ch.org_id IS NULL이면 peers = 이 방의 org 없는 크루 참여 행, 20260930210000). 1:1 방에는 주 에이전트 하나라 넘길 곳이 없다
test('@ 후보: 개인 1:1로 가는 글이면 넘길 에이전트가 없다, 조직 1:1이면 종전처럼 같은 조직 크루', () => {
  const crews = [{ id: 'm', space: 'acme', name: '페퍼' }, { id: 'a', space: 'acme', name: '울프' }, { id: 'b', space: 'beta', name: '오길비' }];
  assert.deepEqual(A.mentionCands(crews, crews[0], '', { personalId: 'tw' }), []);
  assert.deepEqual(A.mentionCands(crews, crews[0], '', { personalId: null }).map((c) => c.id), ['a']);
  assert.deepEqual(A.mentionCands(crews, crews[0], '').map((c) => c.id), ['a'], '맡길 곳을 모르면(예시 데이터) 종전 그대로');
  // 화면 확인(10/5): 조직 1:1에서 '@'를 치면 페퍼가 두 번 — 동기화 충돌 사본(slug .conflict-)이 후보에 섞였다(목록에서는 CX-04로 뺐다)
  assert.deepEqual(A.mentionCands([...crews, { id: 'cp', space: 'acme', name: '울프', copy: true }], crews[0], '').map((c) => c.id), ['a'], '충돌 사본은 후보가 아니다');
});

// 이유(분리 검수 LOW): 목록에는 있는데 서버에 없는 페이지('찾을 수 없음')도 머리줄에 '제목 없음'·저장됨·별이 남았다 — 없는 페이지와 같게
test('머리줄: 서버에 없는 페이지는 제목·저장됨·별을 보이지 않는다', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const node = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body.find((n) => n.type === 'FunctionDeclaration' && n.id.name === 'Header');
  const code = transformSync(source.slice(node.start, node.end), { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code;
  const Header = new Function('require', 'useSession', 'SPACES', 'ME', 'PEOPLE', 't', 'baseOf', 'Link', 'Icon', 'SaveStatus', 'WidthToggle', 'FavToggle', 'HideAllToggle', `${code}\nreturn Header;`)(
    require, () => 'signedIn', [{ key: 'me', kind: 'me', name: 'Office' }], { name: 'User' }, [], (k) => k, () => '/me', ({ children }) => createElement('a', null, children), () => null,
    () => createElement('i', { className: 'save-status' }), () => null, () => createElement('i', { className: 'fav-toggle' }), () => null);
  const page = { id: 'p1', title: '' };
  const missing = renderToStaticMarkup(createElement(Header, { r: { space: 'me', view: 'page' }, page, missing: 'p1' }));
  assert.ok(!missing.includes('save-status') && !missing.includes('fav-toggle') && !missing.includes('page.untitled') && !missing.includes('page.share'), missing); // 공유·더 보기도(없는 페이지를 공유할 수 없다 — 화면 확인 10/5)
  const other = renderToStaticMarkup(createElement(Header, { r: { space: 'me', view: 'page' }, page, missing: 'p0' }));
  assert.ok(other.includes('save-status') && other.includes('fav-toggle') && other.includes('page.untitled') && other.includes('page.share'), '다른 페이지는 그대로');
});

// 이유(분리 검수가 찾은 기존 결함): docs.empty가 견적·계약 사전과 기록(공용 문서) 사전에 다른 문구로 있어, 나중에 연 화면의 문구가 앞 화면을 덮었다
// (기록 화면을 먼저 열면 견적·계약 빈 화면에 '아직 공용 문서가 없습니다'). 사전 키 하나는 한 뜻만
test('화면 사전: 같은 키를 서로 다른 문구로 두 번 정의하지 않는다(기본 사전 포함)', async () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const files = [];
  // 사전 = *_DICT를 내보내는 모든 파일(2차 검수 L9: -i18n.js만 보면 business/i18n.js의 BUSINESS_DICT 등이 빠졌다)
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.m?jsx?$/.test(p) && /export const [A-Z_]+_DICT\b/.test(readFileSync(p, 'utf8'))) files.push(p); } };
  walk(root);
  const seen = new Map(), clash = [];
  for (const f of files) {
    for (const v of Object.values(await import(pathToFileURL(f)))) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      for (const [k, pair] of Object.entries(v)) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
        const prev = seen.get(k), rel = f.slice(root.length + 1);
        if (prev && prev.pair.join('\u0000') !== pair.join('\u0000')) clash.push(`${k}: ${prev.f} / ${rel}`);
        if (!prev) seen.set(k, { pair, f: rel });
        if (t(k) !== k && !pair.includes(t(k))) clash.push(`${k}: 화면에 나오는 문구가 ${rel}와 다르다`); // 기본 사전(core/i18n.js)이 먼저, 그다음 나중에 등록한 사전(가져올 때 등록하지 않는 사전은 키 그대로라 건너뛴다)
      }
    }
  }
  assert.ok(files.length > 30, `사전 파일을 찾았다(${files.length})`);
  assert.deepEqual(clash, []);
});
