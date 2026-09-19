// 기억 문서 경로 — 서버 제약(msgr_org_docs_path_check: `<폴더>/[a-z0-9][a-z0-9_-]{0,79}.md`, 20260914120000)이 영문·숫자만 받는다.
// 검수 D13: "B 채널 메모"·"B 회의록"이 둘 다 b.md가 되어 두 번째가 "이미 있음"으로 막혔다. 같은 경로면 -2, -3…을 붙인다
// (레포 관례 — 회의록 파일명 충돌과 같은 방식). 미리 조회하지 않고 insert 충돌을 보고 다음 후보로 간다(동시에 만들어도 안전).
export const docSlug = (title) => { const s = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); return s || `doc-${Date.now().toString(36)}`; }; // 한글만인 제목은 시간 기반 슬러그

/** n번째 후보 경로(1 = 접미 없음). 슬러그는 60자 이하라 접미를 붙여도 제약(80자) 안이다. */
export const docPath = (folder, slug, n = 1) => `${folder}/${n > 1 ? `${slug}-${n}` : slug}.md`;

export const isPathTaken = (msg) => /duplicate key|msgr_org_docs_path\b/.test(String(msg ?? '')) && !/msgr_org_docs_path_check/.test(String(msg ?? ''));

/** insert(path) → {data, error}를 받아 빈 경로를 찾을 때까지(최대 max번) 시도한다. 마지막까지 막히면 마지막 결과를 돌려준다. */
export async function insertWithFreePath(folder, title, insert, max = 20) {
  const slug = docSlug(title);
  let res;
  for (let n = 1; n <= max; n += 1) {
    res = await insert(docPath(folder, slug, n));
    if (!res?.error || !isPathTaken(res.error.message)) return res;
  }
  return res;
}
