// 맨 아래로(D22 S85) — 바닥에서 한 화면 넘게 올라가 있으면 버튼, 누르면 바닥·바닥 고정 복귀.
// 실측(ego, 픽스처 글 60개, 휠로 위로): 라이트·다크 gap 5713·폰 3816에서 버튼 보임 → 누르면 gap 0~1, 버튼 사라짐, 뒤이은 새 글도 따라감(gap 0)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('배선 — 스크롤 거리로 버튼을 켜고, 누르면 바닥 고정을 되돌린다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /setAway\(gap > el\.clientHeight\);/, '한 화면 넘게 올라가면');
  assert.match(src, /\{away && <div className="msgr-tobottom"><button type="button" className="btn sm" onClick=\{\(\) => \{ const el = feed\.current; if \(!el\) return; stick\.current = true; el\.scrollTop = el\.scrollHeight; setAway\(false\); \}\}>/, '바닥 고정(stick)을 켜야 이후 새 글도 따라간다');
  const i18n = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(i18n, /'thread\.toBottom': \['맨 아래로', 'Jump to latest'\]/);
});
