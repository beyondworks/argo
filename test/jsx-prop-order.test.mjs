// IME 가드 트립와이어 — `{...imeGuard}`와 명시 `onKeyDown`을 한 태그에 같이 쓰면, 나중에 온 쪽이
// 앞의 것을 통째로 덮어쓴다. 조용히 죽는다: 빌드도 린트도 통과하고, 눌러 봐야 안다.
//
// 실사고 2026-07-31(유건 신고): 이름 편집 모달(ui.jsx InputModal)에서 Enter로 저장이 안 됐다.
// 원인은 IME가 아니라 프롭 순서 — 스프레드가 뒤에 있어 제출 핸들러가 사라졌다. 순서를 지키는 규율로는
// 재발을 못 막는다(회의실 입력은 순서를 맞춰 두고 주석까지 달았는데도 같은 함정이 재현됐다).
// 그래서 자기 핸들러가 필요한 자리는 `imeGuardWith(handler)`로 **합쳐서** 넘기고(app/ui.jsx),
// 여기서는 공존 자체를 금지한다 — 순서가 맞고 틀리고를 따질 여지를 없앤다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.jsx$/.test(e.name)) out.push(p);
  }
  return out;
}

test('{...imeGuard}와 명시 onKeyDown은 한 태그에 같이 못 온다 — 한쪽이 죽는다', () => {
  const bad = [];
  for (const file of walk(join(ROOT, 'app'))) {
    // 주석을 지우고 본다 — 이 규칙을 **설명하는 주석**이 규칙 위반으로 잡히기 때문이다(두 번 겪었다:
    // room/page.jsx의 줄 주석, ui.jsx imeGuardWith의 블록 주석). 블록까지 지우는 형태는
    // test/no-hardcoded-runner-label.test.mjs의 stripComments와 같다.
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    for (let i = src.indexOf('{...imeGuard}'); i >= 0; i = src.indexOf('{...imeGuard}', i + 1)) {
      // 태그 구간 = 앞쪽 '<'부터 닫는 '/>'까지. 표현식 속 '<'(비교)에 걸려 구간이 짧아지면
      // 검출을 놓칠 뿐 없는 위반을 만들지는 않는다 — 안전한 쪽으로 틀린다.
      // 같은 태그 안이면 앞이든 뒤든 위반이다 — 뒤에 오는 쪽이 이기는 규칙에 기대지 않는다.
      const close = src.indexOf('/>', i);
      const tag = src.slice(src.lastIndexOf('<', i), close === -1 ? i : close);
      if (tag.includes('onKeyDown')) bad.push(`${relative(ROOT, file)}:${src.slice(0, i).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], `한 태그에 {...imeGuard}와 onKeyDown이 함께 있다(둘 중 하나는 죽는다). imeGuardWith로 합쳐라: ${bad.join(', ')}`);
});
