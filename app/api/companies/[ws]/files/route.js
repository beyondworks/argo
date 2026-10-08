import { readFile, realpath, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { paths } from '../../../../../src/workspace.mjs';
import { guardCompany } from '../../../../auth.mjs';

// 파일 서빙 — vault/files/(첨부) + vault/projects/(크루 산출물), 경로 탈출 차단.
// 채팅 버블 썸네일·기억 화면의 산출물 다운로드가 이 경로를 쓴다.
// vault 전체를 열지 않는 이유: journal/notes는 뷰어(readDoc) 전용으로 남겨 서빙 표면 최소화.
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json',
  // 오피스·아카이브 — 크루 산출물 다운로드 정상화(제보 2026-08-07: 엑셀 등 클릭 다운로드 불가 계열)
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  // ⚠ html은 **의도적으로 넣지 않는다**(발행 전 검수 HIGH-1, 2026-08-07). text/html로 서빙하면
  // 산출물이 앱 오리진에서 실행되는 페이지가 된다 — CSP가 'unsafe-inline'이라 스크립트가 돌고,
  // 첨부 칩·[[링크]]는 download=1 없이 여는 경로라 같은 오리진 XSS가 성립한다(텔레그램 수신
  // 문서가 vault/files/에 .html로 저장되는 투입 경로 실재). octet-stream 폴백 = 다운로드로 끝난다.
};

/** If-None-Match(쉼표 목록·약한 비교 W/·*) — 같은 바이트를 가진 사본이면 true. */
function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(',').some((v) => { const t = v.trim().replace(/^W\//, ''); return t === '*' || t === etag; });
}

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const rel = new URL(req.url).searchParams.get('rel') ?? '';
  // Windows normalize()는 백슬래시를 반환 — 슬래시로 통일해야 files/ 접두 검사가 통과한다
  const norm = normalize(rel).split('\\').join('/');
  // _imported/ = 옵시디언 임포트 리포트·미분류 보관 — 경로만 만들어 두고 서빙 허용 목록에서 빠지면
  // 사용자가 Finder로 찾아가야 한다(2026-07-20 신고와 같은 결함 계급 — 분리 검수 MED-5).
  if (!(norm.startsWith('files/') || norm.startsWith('projects/') || norm.startsWith('_imported/')) || norm.includes('..')) {
    return new Response('잘못된 경로', { status: 400 });
  }
  try {
    // realpath 봉인 — '..' 문자열 검사만으론 심링크를 못 막는다. 에이전트(셸·fs 능력)가 vault 밖을
    // 가리키는 심링크를 만들면 그대로 서빙되던 통로 차단(릴리스 검수 M-3 — 호스팅 합류 시 HIGH 승격 지점).
    const vault = paths(ws).vault;
    const real = await realpath(join(vault, norm));
    if (!real.startsWith((await realpath(vault)) + sep)) {
      return new Response('잘못된 경로', { status: 400 });
    }
    // 캐시 — 매번 재확인(no-cache) + 파일 크기·수정 시각으로 만든 ETag. 같으면 304(본문 없음, 로컬이라 왕복 비용은 작다).
    // 종전 max-age=86400은 같은 경로를 에이전트가 덮어쓰면("시안 수정해줘") 대화창 그림·크게 보기·새로고침·데스크톱 저장이 하루 동안
    // 옛 그림이었다(IMG 1차 검수 MEDIUM, 격리 실측 2026-10-09: 디스크 99B인데 새 답 그림·기본 fetch는 759B 옛 그림).
    const st = await stat(real, { bigint: true });
    const etag = `"${st.size.toString(16)}-${st.mtimeNs.toString(16)}"`;
    const ext = norm.split('.').pop().toLowerCase();
    const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'private, no-cache', etag };
    if (etagMatches(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: { 'cache-control': headers['cache-control'], etag } });
    }
    const buf = await readFile(real);
    // download=1 — 브라우저 강제 다운로드(제보 2026-08-07). a[download] 속성만으론 html 등
    // 렌더 가능 타입이 탭에서 열리는 브라우저·확장 조합이 있어 서버가 attachment로 못박는다.
    // filename*는 RFC 5987(비ASCII 파일명 — 한글 산출물명 다수). 미리보기(썸네일·iframe)는
    // 이 파라미터를 안 보내므로 인라인 유지.
    if (new URL(req.url).searchParams.get('download') === '1') {
      const name = norm.split('/').pop();
      headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    }
    return new Response(buf, { headers });
  } catch {
    return new Response('파일 없음', { status: 404 });
  }
}
