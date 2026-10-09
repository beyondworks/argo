// 랜딩 리눅스 설치 안내(landing/lib/i18n.jsx 'install.note.linux')가 install.sh의 실제 기본 동작과 맞는지 잠근다(H22 3).
// 전에는 '리눅스(x86_64) 서버에 상주 서비스로 설치됩니다'라고 적었지만, 기본 실행(계정 모드)은 argo 명령만 설치한다 —
// 로그인 뒤 `argo service install`을 따로 실행해야 상주한다. 안내 문구와 스크립트가 어긋나면 이 테스트가 빨강이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const note = () => {
  const m = /'install\.note\.linux':\s*\[\s*'([^']*)',\s*'([^']*)',?\s*\]/.exec(read('landing/lib/i18n.jsx'));
  assert.ok(m, "landing/lib/i18n.jsx에 'install.note.linux': ['ko', 'en'] 항목이 있다");
  return { ko: m[1], en: m[2] };
};
/** install.sh의 계정 모드 블록(새 설치의 기본) — `if [ "$LOCAL" = 0 ]; then` 부터 그 블록의 `exit 0` 까지. */
const accountBlock = () => {
  const sh = read('scripts/install.sh');
  const start = sh.indexOf('# ─── 계정 모드 — argo 명령만 설치');
  assert.ok(start > 0, '계정 모드 블록 표지가 있다');
  const end = sh.indexOf('  exit 0\nfi', start);
  assert.ok(end > start, '계정 모드 블록이 exit 0으로 끝난다');
  return sh.slice(start, end);
};

test('랜딩 리눅스 안내 — 기본 설치가 하는 일(argo 명령 설치)과 상주 등록을 따로 하는 명령(argo service install)을 둘 다 정확히 말한다(ko·en)', () => {
  const { ko, en } = note();
  for (const [lang, text] of [['ko', ko], ['en', en]]) {
    assert.match(text, /argo service install/, `${lang}: 상주는 argo service install로 따로 등록한다고 알린다`);
    assert.match(text, /x86_64/, `${lang}: 지원 아키텍처`);
    assert.match(text, /Node\.js 22/, `${lang}: argo 명령은 Node.js 22 이상이 필요하다`);
    assert.match(text, /systemd/, `${lang}: systemd가 필요하다`);
  }
  assert.doesNotMatch(ko, /상주 서비스로 설치/, '설치 명령 한 줄이 상주 서비스를 만든다는 옛 문구가 없다');
  assert.doesNotMatch(en, /as a self-healing service|installs as a .*service/i, '옛 영어 문구가 없다');
  assert.match(ko, /argo 명령을 설치/, 'ko: 설치되는 것은 argo 명령');
  assert.match(en, /Installs the argo command/, 'en: 설치되는 것은 argo 명령');
  assert.match(ko, /같은 명령 재실행/, 'ko: 업데이트 안내는 그대로');
  assert.match(en, /Re-run the same line to update/, 'en: 업데이트 안내는 그대로');
});

test('랜딩 리눅스 안내 ↔ install.sh — 안내가 말하는 사실이 스크립트에 그대로 있다(어긋나면 안내를 고친다)', () => {
  const sh = read('scripts/install.sh');
  assert.match(sh, /NODE_MAJOR" -ge 22 \] \|\| die "argo 명령은 Node\.js 22 이상/, '계정 모드(기본)는 Node.js 22 이상을 요구한다');
  assert.match(sh, /command -v systemctl >\/dev\/null \|\| die/, 'systemd가 없으면 설치하지 않는다');
  assert.match(sh, /aarch64\) die "arm64는 후속 지원 예정/, 'x86_64만 설치한다(arm64는 거절)');
  const block = accountBlock();
  assert.match(block, /\$RUN_CMD service install/, '설치 끝에 상주 등록 명령(argo service install)을 안내한다');
  assert.doesNotMatch(block, /enable argo\.service|start argo\.service|argo\.service\.new/, '기본 설치(계정 모드)는 상주 서비스를 만들지도 켜지도 않는다');
  assert.match(sh, /LOCAL=0\nfor arg in "\$@"/, '--local 없이 실행하면 계정 모드가 기본이다');
});
