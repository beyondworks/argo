import { readFile, realpath } from 'node:fs/promises';
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
};

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const rel = new URL(req.url).searchParams.get('rel') ?? '';
  // Windows normalize()는 백슬래시를 반환 — 슬래시로 통일해야 files/ 접두 검사가 통과한다
  const norm = normalize(rel).split('\\').join('/');
  if (!(norm.startsWith('files/') || norm.startsWith('projects/')) || norm.includes('..')) {
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
    const buf = await readFile(real);
    const ext = norm.split('.').pop().toLowerCase();
    return new Response(buf, {
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=86400' },
    });
  } catch {
    return new Response('파일 없음', { status: 404 });
  }
}
