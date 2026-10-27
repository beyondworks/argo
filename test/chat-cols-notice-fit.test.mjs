// 대화 그리드(.chat-cols)는 본문 맨 위 안내(이번 업데이트 카드·메신저 기록 보관 안내·오류 줄)만큼 줄어든다 — 유건 2026-10-27 "대화창 아래가 짤려".
// 그리드 높이를 calc(100vh − 100px)로만 고정하면 안내 높이만큼 입력창이 창 아래로 밀려 잘렸다(1280×820 창 + 보관 안내: 입력창 아래 끝 793 / 창 792).
// 행동 근거는 격리 dev 서버 헤드리스 실측(PR 본문: 안내 없음 54조합 픽셀 동일, 안내 있음 입력창 731 고정)이고, 이 파일은 그 구조를 잠그는 소스 핀이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const layout = await readFile(new URL('../app/c/[ws]/layout.jsx', import.meta.url), 'utf8');

test('.content가 .chat-cols를 담으면 세로 flex + 창 높이 − 상단바, 그리드는 줄어들 수만 있다(안내가 입력창을 밀어내지 않는다)', () => {
  assert.match(css, /^\.content:has\(> \.chat-cols\) \{ display: flex; flex-direction: column; height: calc\(100vh \/ var\(--z, 1\) - 56px\); \}$/m,
    '본문 높이를 창 안에 고정(배율 보정 포함) — 빼면 안내만큼 그리드가 창 밖으로 밀린다');
  assert.match(css, /^\.content:has\(> \.chat-cols\) > \* \{ flex: none; \}$/m, '안내 카드는 줄지 않는다(카드 내용이 잘리지 않게)');
  assert.match(css, /^\.content:has\(> \.chat-cols\) > \.chat-cols \{ flex: 0 1 auto; min-height: 240px; \}/m,
    '그리드만 줄어든다(flex-shrink 1), 바닥 240 — flex: none·shrink 0으로 바꾸면 종전 잘림이 돌아온다');
});

test('안내가 없을 때 픽셀 동일 — 그리드 기본 크기는 종전 고정 높이(calc(100vh − 100px))와 하단 −70 상쇄 그대로', () => {
  assert.match(css, /\.chat-cols \{\n  display: grid; grid-template-columns: min\(216px, 100% - 244px\) minmax\(0, 1fr\);\n  gap: 18px; align-items: start;\n  height: calc\(100vh \/ var\(--z, 1\) - 100px\); margin-bottom: -70px;\n\}/,
    '기본 크기(flex-basis auto = height)와 :has를 모르는 웹뷰의 폴백');
  // 56(상단바) + 26(.content 위 패딩) + (100vh − 100) + 88(아래 패딩) − 70 = 100vh → 본문 높이 100vh − 56 안에 정확히 들어간다
  const pad = css.match(/^\.content \{ padding: (\d+)px \d+px (\d+)px;/m);
  assert.ok(pad, '.content 패딩 선언');
  assert.equal(Number(pad[1]) + (-100) + Number(pad[2]) - 70, -56, '패딩·오프셋 산식이 본문 높이(100vh − 56)와 맞는다 — 한쪽을 바꾸면 함께 갱신');
});

test('안내 자리는 main.content의 직계 자식이고 페이지(.chat-cols)보다 앞 — :has(> .chat-cols) 선택자가 성립하는 구조', () => {
  const main = layout.slice(layout.indexOf('<main ref={contentRef} className="content"'));
  assert.ok(main.length > 0, 'main.content');
  const iSlot = main.indexOf('<div id="argo-update-notes-slot" />');
  const iArchive = main.indexOf('<MsgrArchiveNotice ws={ws} />');
  const iChildren = main.indexOf(') : children}');
  assert.ok(iSlot > 0 && iArchive > iSlot && iChildren > iArchive, '업데이트 카드 자리 → 보관 안내 → 페이지 순서');
});
