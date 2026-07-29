// hub.listCompanyIds — 스케줄러 틱용 경량 회사 열거의 행위 테스트(실 fs, 임시 ARGO_ROOT).
// listCompanies와의 집합 관계까지 잠근다: 의도한 차이는 "손상 company.json 포함" 하나뿐이어야
// 하고, wsId 규칙 위반 폴더(Finder 복제본 등)는 두 함수 모두 제외해야 한다 — 이 필터가 빠지면
// 하류 paths() throw가 리더 기기 틱을 매분 통째로 죽인다(분리 검수 2026-07-28 HIGH-1·MEDIUM-2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let hub; let ROOT;

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'argo-hub-'));
  process.env.ARGO_ROOT = ROOT;
  hub = await import('../src/hub.mjs');
  const co = async (name, json) => {
    await mkdir(join(ROOT, name), { recursive: true });
    if (json !== undefined) await writeFile(join(ROOT, name, 'company.json'), json);
  };
  await co('co-abc1', JSON.stringify({ id: 'co-abc1', name: '정상', created: '2026-01-01' }));
  await co('co-xyz9', JSON.stringify({ id: 'co-xyz9', name: '정상2', created: '2026-01-02' }));
  await co('no-company-json'); // company.json 없음 — 워크스페이스 아님
  await co('.hidden', '{}'); // 도트 폴더 제외
  await co('co-abc1 copy', '{}'); // Finder 복제본 — wsId 규칙 위반(공백) → 제외
  await co('broken-json', '{oops'); // 손상 company.json — 존재만 보므로 포함(의도한 차이)
  await writeFile(join(ROOT, 'plainfile'), 'x'); // 일반 파일 제외
});
after(async () => { await rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

test('listCompanyIds — 규칙 위반·비워크스페이스·도트 폴더 제외, 폴더명=id', async () => {
  assert.deepEqual((await hub.listCompanyIds()).sort(), ['broken-json', 'co-abc1', 'co-xyz9']);
});

test('listCompanies와의 관계 — 의도한 차이는 손상 company.json 포함뿐', async () => {
  const full = (await hub.listCompanies()).map((c) => c.id).sort();
  assert.deepEqual(full, ['co-abc1', 'co-xyz9'], 'listCompanies는 파싱 실패 폴더를 제외한다');
  const ids = new Set(await hub.listCompanyIds());
  for (const id of full) assert.ok(ids.has(id), `listCompanies의 회사 ${id}가 경량 목록에 없다`);
});
