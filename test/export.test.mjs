// 회사 데이터 내보내기 회귀 테스트 — 제외 목록이 곧 보안 계약이다:
// 자격·연결 파일(.secrets·connections·mcp·직속 도트 전부)은 내보낸 사본에 절대 실리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-exp-'));
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-exphome-'));
const { exportExcluded, exportCompany } = await import('../src/export.mjs');

test('exportExcluded: 자격·금고 계열은 제외, 데이터는 포함', () => {
  // 제외 — 보안 계약
  assert.equal(exportExcluded('.secrets.json'), true, '러너 자격');
  assert.equal(exportExcluded('.workroots.json'), true, '외부 작업 폴더 목록');
  assert.equal(exportExcluded('.sync-state.json'), true, '기기 상태');
  assert.equal(exportExcluded('connections.json'), true, '메신저 봇 토큰');
  assert.equal(exportExcluded('mcp.json'), true, 'MCP env 토큰');
  assert.equal(exportExcluded('vault/.tmp-x.json-1-a'), true, '원자쓰기 임시');
  assert.equal(exportExcluded('chats/a.json.corrupt-123'), true, '손상 백업');
  // 포함 — 사용자 데이터
  assert.equal(exportExcluded('company.json'), false);
  assert.equal(exportExcluded('capabilities.json'), false, '능력 토글은 시크릿 아님');
  assert.equal(exportExcluded('vault/notes/메모.md'), false);
  assert.equal(exportExcluded('chats/.archive/old.json'), false, '한 단계 아래 도트 경로는 정상 데이터');
  assert.equal(exportExcluded('agents/tester.md'), false);
});

test('exportCompany: 데이터는 복사되고 자격 파일은 사본에 없다', async () => {
  const ws = 'exp-co';
  const root = join(process.env.ARGO_ROOT, ws);
  await mkdir(join(root, 'vault', 'notes'), { recursive: true });
  await mkdir(join(root, 'agents'), { recursive: true });
  await writeFile(join(root, 'company.json'), JSON.stringify({ id: ws, name: '내보내기' }));
  await writeFile(join(root, '.secrets.json'), JSON.stringify({ runners: { claude: { value: 'sk-실키' } } }));
  await writeFile(join(root, 'connections.json'), JSON.stringify({ telegram: { token: 'bot-토큰' } }));
  await writeFile(join(root, 'vault', 'notes', '기억.md'), '# 기억\n');
  await writeFile(join(root, 'agents', 'tester.md'), '---\nname: 테스터\n---\n');
  const dest = await mkdtemp(join(tmpdir(), 'argo-exp-dest-'));
  const r = await exportCompany(ws, dest);
  assert.ok(r.target.startsWith(await realpath(dest)), '지정 폴더(canonical) 아래 생성 — 맥 /var→/private/var 정규화');
  assert.equal(r.files, 3, 'company.json + 기억.md + tester.md');
  assert.equal(await readFile(join(r.target, 'vault', 'notes', '기억.md'), 'utf8'), '# 기억\n');
  assert.equal(existsSync(join(r.target, '.secrets.json')), false, '자격 미유출');
  assert.equal(existsSync(join(r.target, 'connections.json')), false, '봇 토큰 미유출');
  // 사본 전체를 훑어도 시크릿 문자열이 없다(경로 누락 방어의 이중 확인)
  async function grepAll(dir) {
    let hit = false;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) hit = hit || await grepAll(p);
      else hit = hit || (await readFile(p, 'utf8')).includes('sk-실키') || (await readFile(p, 'utf8')).includes('bot-토큰');
    }
    return hit;
  }
  assert.equal(await grepAll(r.target), false, '사본 어디에도 시크릿 문자열 없음');
});

test('exportCompany: 보호 구역·미존재 목적지는 거부(workroots 검증 재사용)', async () => {
  await assert.rejects(() => exportCompany('exp-co', process.env.ARGO_ROOT), (e) => e.code === 'protected', 'WS_ROOT 안으로 내보내기 금지');
  await assert.rejects(() => exportCompany('exp-co', '/no/such/dir'), (e) => e.code === 'not-found');
  const d2 = await mkdtemp(join(tmpdir(), 'argo-exp-d2-'));
  await assert.rejects(() => exportCompany('no-such-ws', d2), (e) => e.code === 'not-found');
});
