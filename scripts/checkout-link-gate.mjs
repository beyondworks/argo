// 발행 번들의 LS 체크아웃 링크 게이트 — release.yml이 .next/static에 돌린다(test/checkout-link-gate.test.mjs).
// buy/ 뒤 값이 변형을 정하고 enabled는 허용 목록일 뿐이라, 다른 변형이 같은 buy 값을 쓰면 연간 버튼에 월간 가격이 담긴다(2026-09-26 실사고).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_VARIANTS = new Set(['1956350', '1956353']); // 옛 테스트 모드 변형(2026-09-01 실사고). 새 테스트 변형을 파면 추가.
const LINK_RE = /lemonsqueezy\.com\/checkout\/buy\/([0-9a-f-]{36})\?enabled=(\d+)/g;

export function checkoutLinkProblems(text) {
  const byBuy = new Map();
  for (const [, buy, variant] of text.matchAll(LINK_RE)) (byBuy.get(buy) ?? byBuy.set(buy, new Set()).get(buy)).add(variant);
  if (!byBuy.size) return ['결제 체크아웃 링크가 번들에 없다 — NEXT_PUBLIC_LS_CHECKOUT_* secrets 누락'];
  const problems = [];
  for (const [buy, variants] of byBuy) {
    if (variants.size > 1) problems.push(`서로 다른 변형 ${[...variants].sort().join('·')}이 같은 buy 값 ${buy}를 쓴다 — 변형마다 자기 buy 값(LS 변형 slug)을 써야 한다`);
    for (const v of variants) if (TEST_VARIANTS.has(v)) problems.push(`테스트 모드 변형 ${v}가 번들에 실렸다 — CI secrets를 라이브 링크로 갱신할 것`);
  }
  return problems;
}

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? '.next/static';
  const text = walk(dir).filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
  const found = [...new Set([...text.matchAll(LINK_RE)].map((m) => `${m[1].slice(0, 8)}…?enabled=${m[2]}`))];
  console.log('번들 체크아웃 링크:', found.join(' ') || '<none>');
  const problems = checkoutLinkProblems(text);
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
