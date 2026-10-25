// 채팅 왼쪽 척추 선과 일 카드 겹침(0.1.65 결함 1, 2026-10-25 유건 아이폰 캡처 — "페퍼의 일 · 에이전트가 받았습니다" 카드 왼쪽을 선이 관통).
// 원인: 폰(≤760px)에서 .msgr-v2-work의 margin-left가 0이라 카드가 선(.msgr-spine::before, left 13px·폭 2px) 위에 놓였다.
// 이 시험은 CSS 값으로 "카드 시작(margin-left) > 선 오른쪽 끝(left + width)"을 폭마다 계산한다. 실제 겹침은 앱 안 브라우저 측정(390: 선 25~27, 카드 48).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const px = (decl, prop) => { const m = new RegExp(`(?:^|[;\\s{])${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(decl); return m ? Number(m[1]) : null; };
const ruleBody = (src, selRe) => { const m = new RegExp(`${selRe}\\s*\\{([^}]*)\\}`).exec(src); return m ? m[1] : null; };
const marginLeft = (body) => { const ml = px(body, 'margin-left'); if (ml != null) return ml; const m = /margin:\s*([^;]+)/.exec(body); if (!m) return null; const p = m[1].trim().split(/\s+/).map((v) => parseFloat(v)); return p.length === 4 ? p[3] : p.length >= 2 ? p[1] : p[0]; };

const spine = ruleBody(css, '\\.msgr-spine::before');
const lineRight = px(spine, 'left') + px(spine, 'width');
const phoneBlock = /@media \(max-width: 760px\) \{\s*\.msgr-v2-work \{([^}]*)\}/.exec(css);

test('척추 선 위치(13px + 2px)', () => { assert.equal(lineRight, 15); });

test('데스크톱: 일 카드는 선 오른쪽에서 시작한다', () => {
  const desk = marginLeft(ruleBody(css, '\\.msgr-v2-work'));
  assert.ok(desk > lineRight, `데스크톱 margin-left ${desk}px`);
});

test('폰(≤760px): 일 카드도 선 오른쪽에서 시작한다 — 0이면 선이 카드 안을 관통한다', () => {
  assert.ok(phoneBlock, '폰 규칙');
  const phone = marginLeft(phoneBlock[1]);
  assert.ok(phone > lineRight, `폰 margin-left ${phone}px ≤ 선 오른쪽 끝 ${lineRight}px`);
  assert.equal(phone, 28 + 8, '말풍선 열(아바타 28 + 폰 칸 간격 8)과 같은 줄');
});
