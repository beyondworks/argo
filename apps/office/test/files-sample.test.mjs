// 문서함 예시 저장소(예시 모드) — 서버 office_file_write와 같은 동작·거절 이유인지(유건이 5400에서 보는 흐름이 운영과 같은 뜻이어야 한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleList, sampleWrite, sampleGet, sampleExpired, sampleDriveList, sampleCustomers } from '../src/files/sample.js';
import { seedBusiness } from '../src/business/sample-business.js';
import { matches, missingBizcert } from '../src/files/model.js';

const SP = 'beyondworks';
const list = (o = {}) => sampleList(SP, { match: matches, ...o });

test('예시 데이터: 휴지통 파일은 목록에 없고 휴지통에만, 본문 검색이 된다, 목록에는 본문 앞부분만', async () => {
  const l = await list();
  assert.ok(l.files.length >= 7);
  assert.ok(!l.files.some((f) => f.deleted_at));
  assert.ok((await list({ trash: true })).files.every((f) => f.deleted_at));
  assert.deepEqual((await list({ q: '귀중' })).files.map((f) => f.id), ['sf-quote']); // 견적서 본문에만 있는 글자
  assert.ok((await sampleGet(SP, 'sf-bizcert')).full_text.includes('000-00-10001')); // 업무 예시 원장의 한빛 사업자번호와 같다
  assert.ok(l.files.every((f) => (f.summary ?? '').length <= 200));
});

test('쓰기: 같은 id 다시 만들기는 그대로, 없는 폴더는 거절, 폴더 고리·비지 않은 폴더 지우기 거절', async () => {
  await sampleWrite(SP, 'file.create', { id: 't-1', title: '테스트.pdf', storage_path: 'x' });
  assert.deepEqual(await sampleWrite(SP, 'file.create', { id: 't-1', title: '테스트.pdf', storage_path: 'x' }), { id: 't-1' });
  await assert.rejects(sampleWrite(SP, 'file.create', { id: 't-2', title: 'a', folder_id: 'nope' }), (e) => e.code === 'file_input');
  await assert.rejects(sampleWrite(SP, 'file.create', { id: 't-3', title: '  ' }), (e) => e.code === 'file_input');
  await sampleWrite(SP, 'folder.create', { id: 'fx', name: '상위' });
  await sampleWrite(SP, 'folder.create', { id: 'fy', name: '하위', parent_id: 'fx' });
  await assert.rejects(sampleWrite(SP, 'folder.move', { id: 'fx', parent_id: 'fy' }), (e) => e.code === 'file_input');
  await sampleWrite(SP, 'file.update', { id: 't-1', folder_id: 'fy', category: 'quote' });
  await assert.rejects(sampleWrite(SP, 'folder.delete', { id: 'fy' }), (e) => e.code === 'file_folder_not_empty');
  await sampleWrite(SP, 'file.update', { id: 't-1', folder_id: null });
  await sampleWrite(SP, 'folder.delete', { id: 'fy' });
  assert.ok(!(await list()).folders.some((f) => f.id === 'fy'));
});

test('휴지통 → 되살리기 → 영구 삭제, 30일 지난 것만 정리 대상', async () => {
  await sampleWrite(SP, 'file.trash', { ids: ['t-1'] });
  assert.ok(!(await list()).files.some((f) => f.id === 't-1'));
  assert.deepEqual((await sampleWrite(SP, 'file.restore', { ids: ['t-1'] })).ids, ['t-1']);
  assert.deepEqual((await sampleWrite(SP, 'file.purge', { ids: ['t-1'] })).ids, []); // 휴지통에 없으면 지우지 않는다
  await sampleWrite(SP, 'file.trash', { ids: ['t-1'] });
  assert.deepEqual((await sampleExpired(SP)).files, []); // 방금 지운 것은 아직
  assert.deepEqual((await sampleWrite(SP, 'file.purge', { ids: ['t-1'] })).ids, ['t-1']);
  await assert.rejects(sampleGet(SP, 't-1'), (e) => e.code === 'file_not_found');
});

test('거래처별: 예시에서 사업자등록증 없는 활성 거래처는 주식회사 오름·새벽베이커리', async () => {
  const files = (await list()).files;
  assert.deepEqual(missingBizcert(sampleCustomers(SP), files).map((c) => c.name), ['주식회사 오름', '새벽베이커리']);
});

test('LOW 5: 예시 거래처는 하나 — 문서함 거래처 칸과 업무 › 거래처 카드가 같은 id·이름(업무 예시 원장)', async () => {
  for (const space of ['me', 'beyondworks', 'lean-studio']) {
    const biz = seedBusiness(space).customers;
    assert.deepEqual(sampleCustomers(space).map((c) => [c.id, c.name]), biz.map((c) => [c.id, c.name]));
    const ids = new Set(biz.map((c) => c.id));
    const files = [...(await sampleList(space, { match: matches })).files, ...(await sampleList(space, { match: matches, trash: true })).files];
    for (const f of files.filter((x) => x.customer_id)) assert.ok(ids.has(f.customer_id), `${space}/${f.id}: 업무 원장에 없는 거래처 ${f.customer_id}`);
  }
  const hanbit = seedBusiness(SP).customers[0];
  assert.ok((await list({ customer: hanbit.id })).files.length >= 3, '업무 › 한빛 카드에서 문서가 보인다');
});

test('예시 드라이브: 보기 5종·폴더·검색', () => {
  assert.ok(sampleDriveList({ view: 'mydrive' }).files.some((f) => f.isFolder));
  assert.ok(sampleDriveList({ view: 'home' }).files.every((f) => !f.isFolder));
  assert.equal(sampleDriveList({ view: 'drives' }).files[0].isFolder, true);
  assert.ok(sampleDriveList({ folder: 'd-f-sales' }).files.some((f) => f.name.includes('견적서')));
  assert.equal(sampleDriveList({ q: '세금계산서' }).search, true);
});
