// 오피스 완전 분리(유건 지시 2026-10-13: "오피스는 Argo와 완전히 분리한다. 오피스 연결 목록은 다 뺀다") — 본체에 오피스를 아는 코드가 다시 들어오면 빨강.
// src·app·bin·scripts·integrations·middleware에서 'office'·'오피스'가 든 줄을 파일마다 센다. 마이크로소프트 오피스 문서 형식(docx·xlsx 내보내기·MIME)은 다른 뜻이라 먼저 뺀다.
// 남은 줄은 아래 허용 목록의 개수와 정확히 같아야 한다 — 늘어나도(새 결합) 줄어들어도(목록 갱신 누락) 빨강이다. 목록을 늘리려면 이유를 같이 적는다.
// supabase/(오피스 마이그레이션 — 이력은 지우지 않는다)·오피스 DB 시험(test/office-*-pg — 그 마이그레이션을 지킨다)은 대상이 아니다.
// 오피스 앱(apps/office)은 2026-10-16 저장소에서 떼어 냈다(유건 "오피스는 완전 분리 … 다른 저장소로 두고 새로 개발") — 아래 마지막 시험이 다시 들어오지 않게 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MS_OFFICE = /officedocument|openxmlformats|office-export|오피스 형식|오피스 내보내기|officeholders/i;
const HIT = /office|오피스/i;
// 구글 캘린더 일정 종류 '부재중'(OUT_OF_OFFICE·outOfOffice — 구글 API 고유 값, src/google-rest.mjs)도 Argo 오피스와 다른 뜻이라 뺀다.
const GCAL_OOO = /OUT_OF_OFFICE|outOfOffice/;

/** 남겨도 되는 곳과 그 줄 수 — 이유. */
const ALLOWED = {
  'src/gateway/msgr-handoff.mjs': [10, '오피스 출처 글(meta.source office_*)은 풀 오토 제외 — 권한을 내리는 안전장치(isOfficeSource, 옛 글·오피스 앱이 넣는 글에 그대로 필요)'],
  'src/gateway/msgr.mjs': [17, '같은 안전장치의 배선(officeChain·job.office — 넘김·DM 전달·옛 1:1에서 옮긴 이어 실행에도 내리는 방향으로만)'],
  'src/chat.mjs': [5, '같은 안전장치를 설명하는 주석(풀 오토·호칭 제외), 지운 패널 결재 목적지 주석'],
  'src/connectors.mjs': [1, '커넥터 풀 오토 제외 주석(같은 안전장치)'],
  'src/user-name.mjs': [2, '오피스에서 맡긴 턴은 호칭 제외(같은 안전장치) 주석'],
  'src/composer-delivery.mjs': [1, '메신저·오피스 공용 모듈이라는 사실(오피스 앱이 이 파일을 가져다 쓴다 — 사본은 오피스 앱 몫)'],
  'src/storage-key.mjs': [1, '같은 이유(공용 모듈)'],
  'src/gateway/owner-solo.mjs': [1, '옮겨 온 출처(지운 오피스 도구 모듈) 주석'],
  'src/argo-self.mjs': [1, '지운 하트비트 설정을 설명하는 주석'],
  'src/inbound-marks.mjs': [1, '옛 비서 글 표지 줄을 남긴 이유 주석'],
  'src/personal-notice.mjs': [1, '옮겨 온 이유 주석'],
  'src/permission-gate.mjs': [1, '옛 비서 설정 파일을 크루가 못 고치게 남긴 이유 주석'],
  'src/sync.mjs': [1, '옛 비서 상태 폴더를 계속 올리지 않는 이유 주석'],
  'app/c/[ws]/routines/page.jsx': [1, '지운 하트비트 칸을 설명하는 주석'],
  'app/c/[ws]/settings/page.jsx': [1, '오피스 진입 버튼을 뺀 내력 주석'],
  'app/i18n.jsx': [1, '0.1.107 업데이트 안내 updates.note.officeSplit 한 줄(오피스 분리를 사용자에게 알리는 문구 — 결합 코드 아님)'],
  'app/update-notes-state.mjs': [2, '0.1.107 업데이트 안내 항목 줄과 그 주석(officeSplit 키 — 결합 코드 아님)'],
  'app/api/companies/[ws]/files/route.js': [1, '"오피스·아카이브" 파일 종류 주석(문서 형식 — Argo 오피스 아님)'],
};

function scan() {
  const out = {};
  const count = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => HIT.test(l) && !MS_OFFICE.test(l) && !GCAL_OOO.test(l)).length;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.next') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m?js|jsx|ts|sh|json)$/.test(e)) { const n = count(p); if (n) out[relative(ROOT, p).split('\\').join('/')] = n; }
    }
  };
  for (const d of ['src', 'app', 'bin', 'scripts', 'integrations']) walk(join(ROOT, d));
  const mw = count(join(ROOT, 'middleware.js')); if (mw) out['middleware.js'] = mw;
  return out;
}

test('본체에 오피스 참조가 허용 목록 밖에 없다(파일별 줄 수까지 같다)', () => {
  const got = scan();
  const want = Object.fromEntries(Object.entries(ALLOWED).map(([f, [n]]) => [f, n]));
  assert.deepEqual(got, want);
});

test('오피스 모듈·경로·명령이 본체에 없다 — 커넥터 항목·동의 넘김·argo office·훅·메일 번역·능동 비서', async () => {
  for (const f of ['src/oauth-consent.mjs', 'app/oauth/consent/route.js', 'src/office-cli.mjs', 'integrations/claude-code', 'integrations/office-cli',
    'src/gateway/office-translate.mjs', 'scripts/office-translate-bench.mjs', 'src/assistant', 'app/api/companies/[ws]/assistant/route.js',
    'app/c/[ws]/routines/heartbeat-card.jsx', 'app/c/[ws]/crew/[slug]/assistant-section.jsx', 'app/c/[ws]/crew/[slug]/assistant-view.mjs',
    'src/help/topics/assistant.mjs', 'src/help/topics/heartbeat-mail.mjs']) assert.ok(!existsSync(join(ROOT, f)), f);
  const { CONNECTOR_CATALOG, CONNECTOR_CATALOG_EN } = await import('../src/market.mjs');
  assert.equal([...CONNECTOR_CATALOG, ...CONNECTOR_CATALOG_EN].some((c) => /office/i.test(`${c.id} ${c.url}`)), false, '오피스 연결 목록 없음');
  assert.doesNotMatch(readFileSync(join(ROOT, 'bin/argo.mjs'), 'utf8'), /\boffice\b/, 'argo office 명령 없음');
});

// 오피스 앱 분리(2026-10-16) — 앱 폴더·CI 단계·앱 파일을 읽는 시험이 다시 들어오면 빨강. 마이그레이션(supabase/)·랜딩 소개(landing/)·프로젝트 문서(*.md)는 대상 밖.
test('오피스 앱이 저장소에 없다 — apps/office 폴더, 그 경로를 쓰는 CI·스크립트·시험이 없다', () => {
  assert.ok(!existsSync(join(ROOT, 'apps/office')), 'apps/office');
  const hits = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.next' || e === 'target' || e === 'dist') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p === fileURLToPath(import.meta.url)) continue; // 이 시험 자신(찾는 무늬를 담는다)
      else if (/\.(m?js|jsx|ts|sh|json|ya?ml)$/.test(e)) readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/apps[\\/]office\b|\.\.\/\.\.\/office\//.test(l) && !/떼어 냈다|떼어 냄|분리로 뺐다|분리 —|저장소에서 떼어/.test(l)) hits.push(`${relative(ROOT, p)}:${i + 1}`); });
    }
  };
  for (const d of ['.github', 'src', 'app', 'bin', 'scripts', 'integrations', 'test', 'apps', 'src-tauri/src']) walk(join(ROOT, d));
  assert.deepEqual(hits, [], '오피스 앱 경로를 쓰는 줄');
});
