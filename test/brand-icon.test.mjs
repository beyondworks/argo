// 브랜드 마크 단일 출처 — 아이콘 사본이 정본에서 갈라지지 않게 잠근다.
//
// 배경(2026-07-29): 같은 시점에 마크가 세 종류로 갈라져 있었다 — 랜딩 파비콘은 정본(골드),
// 제품 앱 파비콘은 구 8각별, 데스크톱 아이콘 세트는 흰 나침반 별. 프레임워크가 경로를 강제해서
// (Next는 `app/icon.svg`, Tauri는 소스 SVG) 사본 자체는 없앨 수 없다. 그러니 사본을 지우는 대신
// **갈라지면 실패하게** 만든다.
//
// 데스크톱 PNG/ICNS/ICO 세트는 여기서 못 잡는다(바이너리 파생물) — source-icon.svg가 바뀌면
// `npx @tauri-apps/cli@^2 icon <1024png> -o src-tauri/icons`로 재생성해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON = 'Argo_gold.svg';

// 프레임워크가 위치를 강제하는 사본들. landing/은 별도 배포 브랜치에만 있어 main 체크아웃엔
// 없다 — 있을 때만 검사한다(랜딩 브랜치에서 테스트를 돌리면 거기서도 잠긴다).
const COPIES = ['app/icon.svg', 'src-tauri/icons/source-icon.svg', 'landing/app/icon.svg'];

test('브랜드 마크 사본이 정본과 바이트 동일하다', () => {
  const canon = readFileSync(join(root, CANON));
  let checked = 0;
  for (const rel of COPIES) {
    const p = join(root, rel);
    if (!existsSync(p)) continue; // 이 브랜치엔 없는 표면
    assert.deepEqual(
      readFileSync(p), canon,
      `${rel}가 ${CANON}과 다르다 — 마크가 갈라졌다. 정본을 복사하고, source-icon.svg를 바꿨다면 데스크톱 아이콘 세트도 재생성할 것`,
    );
    checked++;
  }
  assert.ok(checked >= 2, `사본을 ${checked}개만 확인했다 — 경로가 바뀌었는지 COPIES를 점검할 것`);
});

test('정본이 골드 그라디언트 마크다 — 구 마크로 되돌아가지 않았는지', () => {
  const s = readFileSync(join(root, CANON), 'utf8');
  assert.match(s, /viewBox="0 0 882 882"/, '정본 뷰박스가 아니다');
  assert.match(s, /fill="#212121"/, '배경판 색이 정본이 아니다');
  assert.doesNotMatch(s, /#0a0f1a/i, '구 8각별 마크(#0a0f1a)로 되돌아갔다');
  assert.match(s, /linearGradient/, '골드 그라디언트가 없다 — 단색 구 마크일 수 있다');
});
