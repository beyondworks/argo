import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../../../../../src/workspace.mjs';
import { guardCompany, requestLang } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';
import { uploadSizeProblem, UPLOAD_BODY_LIMIT_BYTES } from '../../../../../lib/upload-limit.mjs';

// 첨부 업로드 — vault/files/에 저장한다. vault 안이어야 크루가 Read로 열람할 수 있다(vault 밖 금지 원칙).
// 한도는 app/lib/upload-limit.mjs 한 곳 — 화면이 보내기 전에 같은 판정을 하고(요청 하나에 파일 하나), next.config의 미들웨어 본문 한도도 거기서 온다(2차 검수 M3·4차)
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    // 미들웨어 본문 한도를 넘는 요청은 본문이 잘려 와서 파싱이 'Failed to parse body as FormData'로 끝난다 — 파싱 전에 같은 한도로 413 안내(4차)
    if (Number(req.headers.get('content-length')) > UPLOAD_BODY_LIMIT_BYTES) return apiError('upload_too_large', await requestLang());
    const form = await req.formData();
    const out = [];
    const problem = uploadSizeProblem([...form.values()].filter((v) => typeof v !== 'string'));
    if (problem) return apiError(problem, await requestLang()); // 413 + errorCode(사전, 화면 언어 문구)
    for (const [, v] of form.entries()) {
      if (typeof v === 'string') continue;
      const safe = (v.name || 'file').replace(/[^\w.\-가-힣]/g, '_').slice(-80);
      const rel = `files/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${safe}`;
      await mkdir(join(paths(ws).vault, 'files'), { recursive: true });
      await writeFile(join(paths(ws).vault, rel), Buffer.from(await v.arrayBuffer()));
      const mime = v.type || 'application/octet-stream';
      out.push({ rel, name: v.name || safe, mime, isImage: IMAGE_MIME.test(mime) });
    }
    return Response.json({ files: out });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
