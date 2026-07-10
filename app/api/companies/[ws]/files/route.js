import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { paths } from '../../../../../src/workspace.mjs';

// 첨부 파일 서빙 — vault/files/ 만, 경로 탈출 차단. 채팅 버블 썸네일이 이 경로를 쓴다.
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json',
};

export async function GET(req, { params }) {
  const { ws } = await params;
  const rel = new URL(req.url).searchParams.get('rel') ?? '';
  const norm = normalize(rel);
  if (!norm.startsWith('files/') || norm.includes('..')) {
    return new Response('잘못된 경로', { status: 400 });
  }
  try {
    const buf = await readFile(join(paths(ws).vault, norm));
    const ext = norm.split('.').pop().toLowerCase();
    return new Response(buf, {
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=86400' },
    });
  } catch {
    return new Response('파일 없음', { status: 404 });
  }
}
