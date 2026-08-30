import { relative, join, resolve, basename, sep } from 'node:path';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { listDocs, listProjectDocs, readDoc } from '../../../../../src/hub.mjs';
import { saveNote, updateIndex } from '../../../../../src/memory.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { EXPORTS } from '../../../../../src/office-export.mjs';
import { appendEvent } from '../../../../../src/events.mjs';
import { guardCompany, langFromCookieHeader } from '../../../../auth.mjs';
import { apiError } from '../../../../apimsg.mjs';

/** notes/ 안의 안전한 절대 경로만 통과 — 기억 통제(편집/삭제)는 주제 노트에만 허용된다. */
function noteFile(ws, rel) {
  const p = paths(ws);
  const file = resolve(p.vault, rel);
  // sep 사용 — Windows resolve()는 백슬래시라 '/' 하드코딩이면 정상 노트도 오차단
  if (!file.startsWith(resolve(p.notes) + sep) || !file.endsWith('.md')) throw new Error('주제 노트만 수정할 수 있습니다');
  return file;
}

export async function GET(req, { params }) {
  // 표시 언어 — 오류 문구를 사용자 화면 언어(argo-lang 쿠키)로 그린다(#333 계약의 기능 라우트 합류)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const url = new URL(req.url);
    const rel = url.searchParams.get('rel');
    if (rel) {
      try {
        // download=1 — 원문 md를 첨부로(뷰어의 MD 다운로드 버튼). readDoc이 경로 탈출을 이미 막는다.
        // format=docx|xlsx|csv — 기억을 오피스 형식으로(유건 지시 4-2). 외부 의존 없는 src/export.mjs
        const fmt = url.searchParams.get('format');
        if (fmt && EXPORTS[fmt]) {
          const base = (rel.split('/').pop() || 'memory').replace(/\.md$/, '');
          const body = EXPORTS[fmt].make(await readDoc(ws, rel));
          return new Response(body, {
            headers: { 'Content-Type': EXPORTS[fmt].mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.${fmt}`)}` },
          });
        }
        if (url.searchParams.get('download') === '1') {
          const name = rel.split('/').pop() || 'memory.md';
          return new Response(await readDoc(ws, rel), {
            headers: {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            },
          });
        }
        return Response.json({ rel, content: await readDoc(ws, rel) });
      } catch (e) {
        // 깨진 위키링크(삭제·이동된 문서) — raw ENOENT는 서버 절대 경로를 UI에 노출한다(SaaS 레이아웃 유출)
        if (e?.code === 'ENOENT') return apiError('vault_doc_not_found', lang, rel);
        throw e;
      }
    }
    // projects = 크루 산출물(별도 축) — 기억(docs)과 분리 반환. 기억 수·별자리 그래프에 산출물이 섞이지 않는다.
    // 산출물 목록 실패가 기억 뷰까지 무너뜨리지 않게 격벽(릴리스 검수 M-2)
    const [docs, projects] = await Promise.all([listDocs(ws), listProjectDocs(ws).catch(() => [])]);
    let index = '';
    try { index = await readDoc(ws, '_index.md'); } catch {}
    return Response.json({ docs, projects, index });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 지식 노트 직접 작성 — 저장 즉시 기존 기억과 자동 링크. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { title, content } = await req.json();
    if (!title?.trim() || !content?.trim()) {
      return Response.json({ error: '제목과 내용이 필요합니다' }, { status: 400 });
    }
    // 신규 작성 — 슬러그 충돌 시 기존 노트를 덮지 않고 접미 번호로 분리 저장(기억 유실 방지).
    const { file, linked } = await saveNote(ws, title, content, { create: true });
    return Response.json({ rel: relative(paths(ws).vault, file), linked });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 주제 노트 직접 수정 — 사용자가 AI의 기억을 그 자리에서 고친다(통제 원칙). */
export async function PUT(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { rel, content } = await req.json();
    if (!rel || !content?.trim()) return Response.json({ error: 'rel·content가 필요합니다' }, { status: 400 });
    await writeFile(noteFile(ws, rel), content.endsWith('\n') ? content : `${content}\n`);
    await updateIndex(ws);
    await appendEvent(ws, { type: 'memory', ok: true, notes: [basename(rel, '.md')], op: 'edit' });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 주제 노트 삭제 — vault/.trash/로 이동(감사 가능), 인덱스에서 즉시 제거. */
export async function DELETE(req, { params }) {
  // 표시 언어 — GET과 같은 계약(오류 문구를 argo-lang 쿠키 언어로)
  const lang = langFromCookieHeader(req.headers.get('cookie'));
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const rel = new URL(req.url).searchParams.get('rel');
    const file = noteFile(ws, rel ?? '');
    const trash = join(paths(ws).vault, '.trash');
    await mkdir(trash, { recursive: true });
    try {
      await rename(file, join(trash, `${Date.now()}-${basename(file)}`));
    } catch (e) {
      // 이미 삭제·이동된 노트 — raw ENOENT는 서버 절대 경로를 UI에 노출한다(GET과 같은 가림).
      // rename만 좁게 감싼다: 이동 성공 후 후속(updateIndex 등) 실패가 "문서 없음 404"로 오보되지 않게.
      if (e?.code === 'ENOENT') return apiError('vault_doc_not_found', lang, rel);
      throw e;
    }
    await updateIndex(ws);
    await appendEvent(ws, { type: 'memory', ok: true, notes: [basename(file, '.md')], op: 'delete' });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
