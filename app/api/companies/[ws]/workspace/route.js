// Codex식 파일 열기 API — 회사 워크스페이스 + 등록 외부 작업 폴더의 트리/검색/문서 열기.
import {
  listWorkspaceDirectory,
  listWorkspaceToolRoots,
  openWorkspaceToolFile,
  readWorkspaceToolRaw,
  saveWorkspaceToolMarkdown,
  searchWorkspaceToolFiles,
} from '../../../../../src/workspace-tools.mjs';
import { csrfDenied, guardCompany } from '../../../../auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const fail = (error) => Response.json(
  { error: error?.code || 'workspace-tool-error' },
  { status: error?.status || 400 },
);

export async function GET(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'roots';
    const root = url.searchParams.get('root') || 'company';
    const path = url.searchParams.get('path') || '';

    if (action === 'roots') {
      const roots = await listWorkspaceToolRoots(ws);
      return Response.json({ roots: roots.map(({ id, kind, label, location }) => ({ id, kind, label, location })) });
    }
    if (action === 'list') return Response.json(await listWorkspaceDirectory(ws, root, path));
    if (action === 'open') return Response.json(await openWorkspaceToolFile(ws, root, path));
    if (action === 'search') {
      return Response.json(await searchWorkspaceToolFiles(ws, root, url.searchParams.get('q') || ''));
    }
    if (action === 'raw') {
      const file = await readWorkspaceToolRaw(ws, root, path);
      return new Response(file.body, {
        headers: {
          // 실제 인라인 문서는 스크립트를 실행하지 않는 래스터 이미지와 PDF만.
          // HTML/SVG/JS 등은 브라우저가 같은 출처 문서로 실행하지 못하게 첨부 바이너리로 고정한다.
          'content-type': file.inline ? file.type : 'application/octet-stream',
          'content-disposition': `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    return Response.json({ error: 'unknown-action' }, { status: 400 });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { root = 'company', path = '', content, version } = await req.json();
    return Response.json(await saveWorkspaceToolMarkdown(ws, root, path, content, version));
  } catch (error) {
    return fail(error);
  }
}
