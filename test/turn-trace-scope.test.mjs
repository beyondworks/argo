// 작업 과정 조회 범위(보안 검토 후속 2026-10-09) — /trace(전체)와 진행 폴·회의실 응답이 1:1 대화 라우트와 같은 접근 판정을 받는다.
// 회사 접근권이 없으면(로그인 없음·다른 계정 귀속·없는 회사) 작업 과정도 못 본다. 인증 켜짐은 모듈 로드 시 env로 정해져 자식 프로세스로 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

test('인증 켜짐 — /trace·/room은 /chat과 같은 판정(상태·코드), 막히면 기록 본문이 없다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-trace-scope-'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/trace-authon-probe.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ARGO_ROOT: root, ARGO_ENC_VAULT: '0', NEXT_PUBLIC_SUPABASE_URL: 'https://argo-test.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-placeholder' },
  });
  assert.equal(r.status, 0, `프로브 실패: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.authOn, true, '전제: 인증 켜짐');
  for (const mode of ['noGuest', 'guest']) {
    for (const k of ['ok', 'linked', 'missing']) {
      const { chat, trace, room } = out[mode][k];
      assert.equal(trace.status === 200, chat.status === 200, `${mode}/${k}: /trace 허용 여부가 /chat과 같다 — chat ${chat.status} trace ${trace.status}`);
      if (chat.status !== 200) {
        assert.deepEqual([trace.status, trace.errorCode], [chat.status, chat.errorCode], `${mode}/${k}: 같은 거절`);
        assert.deepEqual([room.status, room.errorCode], [chat.status, chat.errorCode], `${mode}/${k}: 회의실도 같은 거절`);
        assert.equal(trace.hasTrace, false, '거절이면 기록 본문이 없다');
      }
    }
  }
  assert.equal(out.noGuest.ok.chat.status, 401, '로그인 없음 — 1:1도 못 본다');
  assert.equal(out.guest.ok.trace.status, 200, '게스트(로컬 1인) — 자기 회사는 본다');
  assert.equal(out.guest.ok.trace.hasTrace, true);
  assert.equal(out.guest.linked.trace.status, 403, '다른 계정에 귀속된 회사는 못 본다');
});
