// 폰 채팅 목록 — 선택된 대화가 안 읽음이면 이름·배지 색이 바탕과 같아지던 결함(UX 점검 C, 2026-10-01).
// 데스크톱 활성 행(색 채운 띠)용 `.item.active.unread .name { color: var(--primary-fg) }`가 폰의 "띠 없음"(.item.active { background: none })
// 재정의와 같이 남아, 라이트에서는 흰 글씨가 흰 바탕에, 다크에서는 어두운 글씨가 어두운 바탕에 놓였다.
// 이 테스트는 styles.css를 읽어 폰 홈 목록의 실제 연결(.msgr-phone.phone-home → .msgr-side → .msgr-list → .item → .name)에서
// 이기는 color·background를 계산한다(자식·가상 클래스 없는 선택자만 — 단순 모형). 실제 브라우저 계산 색은 PR 본문의 전후 측정이 정본.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rules(src) { // 중첩은 @media 한 겹까지(이 파일의 구조)
  const out = []; let i = 0; let order = 0;
  const block = (s, from) => { let d = 1, j = from; while (d && j < s.length) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; } return j; };
  const walk = (s) => {
    let k = 0;
    while (k < s.length) {
      const open = s.indexOf('{', k); if (open < 0) break;
      const head = s.slice(k, open).trim(); const end = block(s, open + 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(s.slice(open + 1, end - 1));
      else if (!head.startsWith('@')) out.push({ sels: head.split(',').map((x) => x.trim()), body: s.slice(open + 1, end - 1), order: order++ });
      k = end;
    }
  };
  walk(src); void i; return out;
}
const R = rules(css);
const compound = (s) => { const m = s.match(/^(?:\.[\w-]+)+$/); return m ? s.split('.').filter(Boolean) : null; };
const prop = (body, name) => { const m = [...body.matchAll(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'g'))]; return m.length ? m[m.length - 1][1].trim() : null; };

/** chain: 바깥→안쪽 요소 클래스 목록. 마지막이 대상. 이기는 선언 값(명시도·순서)을 돌려준다. */
function winner(chain, name) {
  let best = null;
  for (const r of R) for (const sel of r.sels) {
    const parts = sel.split(/\s+/).map(compound); if (parts.some((p) => !p)) continue;
    const last = parts[parts.length - 1]; if (!last.every((c) => chain[chain.length - 1].includes(c))) continue;
    let at = chain.length - 2, ok = true;
    for (let p = parts.length - 2; p >= 0 && ok; p--) { while (at >= 0 && !parts[p].every((c) => chain[at].includes(c))) at--; if (at < 0) ok = false; else at--; }
    if (!ok) continue;
    const v = prop(r.body, name); if (v == null) continue;
    const spec = parts.reduce((n, p) => n + p.length, 0);
    if (!best || spec > best.spec || (spec === best.spec && r.order > best.order)) best = { spec, order: r.order, v, sel };
  }
  return best?.v ?? null;
}
const row = (cls) => [['msgr-phone', 'phone-home'], ['msgr-side'], ['msgr-list'], ['item', ...cls]];
const name = (cls) => [...row(cls), ['name']];
const badge = (cls) => [...row(cls), ['msgr-badge']];

test('폰 채팅 목록 — 선택(active)+안 읽음 행의 이름·배지 색은 선택 안 된 안 읽음 행과 같다(띠가 없으니 색을 뒤집지 않는다)', () => {
  assert.equal(winner(name(['active', 'unread']), 'color'), winner(name(['unread']), 'color'), '이름 색');
  assert.equal(winner(badge(['active', 'unread']), 'background'), winner(badge(['unread']), 'background'), '배지 바탕');
  assert.equal(winner(badge(['active', 'unread']), 'color'), winner(badge(['unread']), 'color'), '배지 글자');
});

test('폰 채팅 목록 — 선택 행의 이름 색은 바탕(var(--bg))과 달라야 한다(안 읽음이든 아니든)', () => {
  for (const cls of [['active'], ['active', 'unread']]) {
    const c = winner(name(cls), 'color') ?? 'inherit';
    assert.ok(!/primary-fg|var\(--bg\)/.test(c), `${cls.join('.')}: ${c}`);
  }
});

test('데스크톱 목록(폰 홈 밖)은 그대로 — 채운 활성 띠 위의 이름·배지는 primary-fg', () => {
  const desk = (cls, el) => [['msgr-list'], ['item', ...cls], [el]];
  assert.equal(winner(desk(['active', 'unread'], 'name'), 'color'), 'var(--primary-fg)');
  assert.equal(winner(desk(['active'], 'msgr-badge'), 'background'), 'var(--primary-fg)');
});
