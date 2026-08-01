// 브랜드 마크 단일 출처 — 아이콘 사본이 정본에서 갈라지지 않게 잠근다.
//
// 배경(2026-07-29): 같은 시점에 마크가 세 종류로 갈라져 있었다 — 랜딩 파비콘은 정본(골드),
// 제품 앱 파비콘은 구 8각별, 데스크톱 아이콘 세트는 흰 나침반 별. 프레임워크가 경로를 강제해서
// (Next는 `app/icon.svg`, Tauri는 소스 SVG) 사본 자체는 없앨 수 없다. 그러니 사본을 지우는 대신
// **갈라지면 실패하게** 만든다.
//
// 데스크톱 PNG/ICNS/ICO 세트는 여기서 못 잡는다(바이너리 파생물) — source-icon.svg가 바뀌면
// `npx @tauri-apps/cli@^2 icon src-tauri/icons/source-icon.svg`로 재생성해야 한다.
//
// **정본이 둘이다**(유건 지시 2026-08-01): 화면 안 파비콘은 골드 온 다크(Argo_gold.svg), 독·작업표시줄에
// 서는 앱 아이콘은 밝은 판(Argo_app.svg). 앱 아이콘은 OS 배경 위에 놓이므로 어두운 판이 배경에 묻혔다.
// 정본이 둘이라는 사실 자체를 여기서 잠근다 — 안 그러면 "사본이 갈라졌다"고 오해한 다음 사람이
// source-icon.svg를 골드로 되돌리고, 앱 아이콘이 조용히 원위치한다(분리 검수 지적 2026-08-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON = 'Argo_gold.svg';      // 화면 안(파비콘)
const CANON_APP = 'Argo_app.svg';   // OS 아이콘(독·작업표시줄·설치본)

// 프레임워크가 위치를 강제하는 사본들. landing/은 별도 배포 브랜치에만 있어 main 체크아웃엔
// 없다 — 있을 때만 검사한다(랜딩 브랜치에서 테스트를 돌리면 거기서도 잠긴다).
const COPIES = ['app/icon.svg', 'landing/app/icon.svg']; // 파비콘 계열만 — 앱 아이콘은 정본이 다르다

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
  assert.ok(checked >= 1, `사본을 ${checked}개만 확인했다 — 경로가 바뀌었는지 COPIES를 점검할 것`);
});

test('앱 아이콘 원본이 앱 정본과 바이트 동일하다 — 재생성해도 되돌아가지 않게', () => {
  // tauri icon은 source-icon.svg에서 세트를 만든다. 이 파일이 파비콘 정본으로 되돌아가 있으면
  // 다음 재생성 때 앱 아이콘이 조용히 어두운 판으로 원위치한다 — 그게 이 단언이 막는 것이다.
  const app = readFileSync(join(root, CANON_APP));
  assert.deepEqual(readFileSync(join(root, 'src-tauri/icons/source-icon.svg')), app,
    `source-icon.svg가 ${CANON_APP}과 다르다 — 앱 아이콘 세트를 재생성하면 도안이 바뀐다`);
  // 두 정본이 실제로 다른 도안이어야 한다(같아지면 이 분리가 무의미하고, 앱 아이콘이 배경에 묻힌다).
  assert.notDeepEqual(app, readFileSync(join(root, CANON)), '앱 정본과 파비콘 정본이 같아졌다 — 분리 이유가 사라졌다');
});

test('정본이 골드 그라디언트 마크다 — 구 마크로 되돌아가지 않았는지', () => {
  const s = readFileSync(join(root, CANON), 'utf8');
  assert.match(s, /viewBox="0 0 882 882"/, '정본 뷰박스가 아니다');
  assert.match(s, /fill="#212121"/, '배경판 색이 정본이 아니다');
  assert.doesNotMatch(s, /#0a0f1a/i, '구 8각별 마크(#0a0f1a)로 되돌아갔다');
  assert.match(s, /linearGradient/, '골드 그라디언트가 없다 — 단색 구 마크일 수 있다');
});
