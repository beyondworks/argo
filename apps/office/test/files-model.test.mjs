// 문서함 규칙(유건 10/2, 트랙 B) — 인트라넷 문서함·거래처 첨부와 같은 판정 + 자동 분류·거래처 연결.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, kindOf, ocrable, uploadCheck, safeName, storagePath, segOf, classify, matchCustomer, findCustomer, clip, matches,
  filterFiles, countBy, groupByCategory, topCategories, missingBizcert, folderPath, canMoveFolder, childFolders, expired, daysLeft,
  parseTags, purgeDue, uploadSummary, MAX_BYTES,
} from '../src/files/model.js';

test('유형: 인트라넷 4종(PDF·이미지·문서·기타), 형식이 비어도 확장자로 본다', () => {
  assert.equal(kindOf('a.pdf', 'application/pdf'), 'pdf');
  assert.equal(kindOf('scan.JPG', ''), 'image');
  assert.equal(kindOf('계약서.hwp', 'application/octet-stream'), 'doc');
  assert.equal(kindOf('표.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'doc');
  assert.equal(kindOf('logo.svg', 'image/svg+xml'), 'other'); // 스크립트를 품을 수 있어 그림으로 열지 않는다
  assert.equal(kindOf('a.zip', 'application/zip'), 'other');
  assert.equal(ocrable({ filename: 'a.png', mime: 'image/png' }), true);
  assert.equal(ocrable({ filename: 'a.docx', mime: '' }), false);
  assert.equal(ocrable({ kind: 'link', filename: 'a.pdf' }), false);
});

test('올리기 검사: 50MB 상한·빈 파일·허용 밖 형식, 모르는 형식은 확장자로 통과', () => {
  assert.equal(uploadCheck({ name: 'a.pdf', size: 10, type: 'application/pdf' }), null);
  assert.equal(uploadCheck({ name: 'a.pdf', size: MAX_BYTES + 1, type: 'application/pdf' }), 'tooBig');
  assert.equal(uploadCheck({ name: 'a.pdf', size: 0, type: 'application/pdf' }), 'empty');
  assert.equal(uploadCheck({ name: 'a.bin', size: 5, type: 'application/octet-stream' }), null);
  assert.equal(uploadCheck({ name: 'a.exe', size: 5, type: 'application/x-msdownload' }), 'type');
  assert.equal(uploadCheck({ name: 'a.hwp', size: 5, type: '' }), null);
});

test('경로 이름: 경로 글자·제어 문자를 빼고 확장자는 살린다, 서버가 검사하는 모양', () => {
  assert.equal(safeName('../../etc/passwd'), '_etc_passwd');
  assert.equal(safeName('한빛 견적서 (최종).pdf'), '한빛 견적서 (최종).pdf');
  assert.equal(safeName('a\u0000b.png'), 'a_b.png');
  assert.equal(safeName(''), 'file');
  assert.equal(storagePath(segOf('o1', 'u1'), 'id1', 'x/y.pdf'), 'o-o1/id1/x_y.pdf');
  assert.equal(segOf(null, 'u1'), 'u-u1');
  assert.equal(storagePath('u-u1', 'id', 'a.pdf').split('/').length, 3);
});

test('자동 분류: 이름이 먼저, 다음 읽은 글자, 명함은 짧은 글자에 전화·메일', () => {
  assert.equal(classify({ name: '한빛코퍼레이션_견적서.pdf' }), 'quote');
  assert.equal(classify({ name: '용역계약서_서명본.pdf' }), 'contract');
  assert.equal(classify({ name: '사업자등록증.jpg' }), 'bizcert');
  assert.equal(classify({ name: '통장사본.png' }), 'bankbook');
  assert.equal(classify({ name: '9월 세금계산서.pdf' }), 'evidence');
  assert.equal(classify({ name: 'scan_001.jpg', text: '사업자등록증\n등록번호 123-45-67890\n개업연월일 2020년' }), 'bizcert');
  assert.equal(classify({ name: 'IMG_2231.jpg', mime: 'image/jpeg', text: '김민수 팀장\n010-1234-5678\nminsu@hanbit.co.kr' }), 'card');
  assert.equal(classify({ name: 'IMG_2231.pdf', mime: 'application/pdf', text: '김민수 팀장\n010-1234-5678\nminsu@hanbit.co.kr' }), 'general'); // 명함은 그림만
  assert.equal(classify({ name: '회의록.docx', text: '다음 주 일정' }), 'general');
  assert.ok(CATEGORIES.includes('bankbook'));
});

test('거래처 연결: 정확 일치 먼저, 부분 일치는 하나일 때만(인트라넷 docgen/save.ts)', () => {
  const cs = [{ id: 'a', name: '한빛코퍼레이션' }, { id: 'b', name: '한빛상사' }, { id: 'c', name: '넥스트필드', biz_no: '123-45-67890' }];
  assert.equal(matchCustomer('한빛상사', cs).id, 'b');
  assert.equal(matchCustomer('한빛', cs), null); // 둘 다 포함 — 애매하면 안 묶는다
  assert.equal(matchCustomer('(주)넥스트필드', cs).id, 'c');
  assert.equal(matchCustomer('', cs), null);
  assert.equal(findCustomer({ name: 'scan.jpg', text: '등록번호 1234567890' }, cs).id, 'c'); // 사업자번호
  assert.equal(findCustomer({ name: '한빛코퍼레이션 계약서.pdf' }, cs).id, 'a');
  assert.equal(findCustomer({ name: '문서.pdf', text: '한빛상사와 한빛코퍼레이션' }, cs), null);
});

test('요약·전문 자르기와 검색(제목·파일명·본문·태그, 정규화)', () => {
  const { summary, full_text } = clip('가'.repeat(150_000));
  assert.equal(summary.length, 1900); assert.equal(full_text.length, 100_000);
  const f = { title: '견적서', filename: 'q.pdf', full_text: '넥스트필드 귀중', tags: ['긴급'] };
  assert.ok(matches(f, '넥스트')); assert.ok(matches(f, '긴급')); assert.ok(matches(f, 'Q.PDF')); assert.ok(!matches(f, '한빛'));
  assert.ok(matches(f, '  ')); // 빈 검색 = 전부
  assert.ok(matches({ title: '가' }, '가')); // 맥에서 온 풀어쓴 한글(NFD)
});

test('필터·건수·분류 묶음·많은 분류 3개', () => {
  const fs = [{ category: 'quote', customer_id: 'a', folder_id: null }, { category: 'quote', customer_id: 'b', folder_id: 'f1' }, { category: 'contract', customer_id: 'a' }, {}];
  assert.equal(filterFiles(fs, { category: 'quote' }).length, 2);
  assert.equal(filterFiles(fs, { customer: 'a' }).length, 2);
  assert.equal(filterFiles(fs, { folder: null }).length, 3);
  assert.equal(filterFiles(fs, { folder: 'f1' }).length, 1);
  assert.deepEqual(countBy(fs), { quote: 2, contract: 1, general: 1 });
  assert.deepEqual(groupByCategory(fs).map(([c]) => c), ['quote', 'contract', 'general']);
  assert.equal(topCategories(fs, (c) => c.toUpperCase(), 2), 'QUOTE 2 · CONTRACT 1');
});

test('사업자등록증 미보유: 종료 거래처와 휴지통 파일은 빼고', () => {
  const cs = [{ id: 'a' }, { id: 'b', status: 'closed' }, { id: 'c' }, { id: 'd' }];
  const fs = [{ category: 'bizcert', customer_id: 'a' }, { category: 'bizcert', customer_id: 'c', deleted_at: '2026-10-01' }, { category: 'quote', customer_id: 'd' }];
  assert.deepEqual(missingBizcert(cs, fs).map((c) => c.id), ['c', 'd']);
});

test('폴더 경로·옮기기 판정·아래 폴더', () => {
  const fo = [{ id: 'a', name: '계약', parent_id: null }, { id: 'b', name: '2026', parent_id: 'a' }, { id: 'c', name: '10월', parent_id: 'b' }, { id: 'd', name: '견적' }];
  assert.deepEqual(folderPath(fo, 'c').map((f) => f.id), ['a', 'b', 'c']);
  assert.equal(canMoveFolder(fo, 'a', 'c'), false);
  assert.equal(canMoveFolder(fo, 'a', 'a'), false);
  assert.equal(canMoveFolder(fo, 'c', 'd'), true);
  assert.equal(canMoveFolder(fo, 'c', null), true);
  assert.deepEqual(childFolders(fo, null).map((f) => f.name), ['견적', '계약']);
  const loop = [{ id: 'x', parent_id: 'y' }, { id: 'y', parent_id: 'x' }];
  assert.ok(folderPath(loop, 'x').length <= 64); // 고리가 있어도 멈춘다
});

test('휴지통 30일, 정리는 하루 한 번, 태그 입력, 올리기 결과 요약', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(expired({ deleted_at: '2026-08-31T00:00:00Z' }, now), true);
  assert.equal(expired({ deleted_at: '2026-09-10T00:00:00Z' }, now), false);
  assert.equal(expired({}, now), false);
  assert.equal(daysLeft({ deleted_at: '2026-09-30T00:00:00Z' }, now), 28);
  assert.equal(purgeDue(null, now), true); assert.equal(purgeDue(now - 3600e3, now), false); assert.equal(purgeDue(now - 90000e3, now), true);
  assert.deepEqual(parseTags('견적서, 한빛 ,  ,#긴급,견적서'), ['견적서', '한빛', '긴급']);
  assert.deepEqual(uploadSummary(['a.pdf'], [true]), { key: 'files.uploaded1', vars: { name: 'a.pdf' } });
  assert.deepEqual(uploadSummary(['a', 'b'], [true, true]), { key: 'files.uploadedN', vars: { n: 2 } });
  assert.deepEqual(uploadSummary(['a', 'b'], [true, 'tooBig']), { key: 'files.uploadedMixed', vars: { ok: 1, failed: 1 } });
});

test('재검수 LOW-D: 서버·DB 오류 코드마다 화면 문구(ko/en)가 있다 — 올리기 시간이 지난 자리(file_expired)도 일반 오류로 뭉개지지 않는다', async () => {
  const { FILE_ERRORS } = await import('../src/files/model.js');
  const { FILES_DICT } = await import('../src/files/files-i18n.js');
  assert.equal(FILE_ERRORS.file_expired, 'uploadExpired');
  for (const [code, reason] of Object.entries(FILE_ERRORS)) {
    const v = FILES_DICT[`files.err.${reason}`];
    assert.ok(Array.isArray(v) && v[0] && v[1], `${code} → files.err.${reason} ko/en 문구`);
  }
  assert.match(FILES_DICT['files.err.uploadExpired'][0], /다시 올려/);
});

test('LOW-B 사용량 줄: "쓴 용량 / 한도", 한도의 80%부터 안내(요금제 이름·가격 없음)', async () => {
  const { usageInfo } = await import('../src/files/model.js');
  assert.deepEqual(usageInfo({ used: 1363149, quota: 1073741824 }), { used: 1363149, quota: 1073741824, ratio: 1363149 / 1073741824, near: false });
  assert.equal(usageInfo({ used: 858993459, quota: 1073741824 }).near, false, '80% 바로 아래');
  assert.equal(usageInfo({ used: 858993460, quota: 1073741824 }).near, true, '80%부터');
  assert.equal(usageInfo({ used: 2e9, quota: 1073741824 }).near, true, '넘쳐도(옛 데이터) 안내만');
  assert.equal(usageInfo(null), null, '사용량이 없으면 줄을 그리지 않는다');
  assert.equal(usageInfo({ used: 5, quota: 0 }), null);
});
