import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../../../../../src/workspace.mjs';
import { guardCompany } from '../../../../../auth.mjs';

// 첨부 업로드 — vault/files/에 저장한다. vault 안이어야 크루가 Read로 열람할 수 있다(vault 밖 금지 원칙).
const MAX_FILE = 10 * 1024 * 1024; // 10MB
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const form = await req.formData();
    const out = [];
    for (const [, v] of form.entries()) {
      if (typeof v === 'string') continue;
      if (v.size > MAX_FILE) {
        return Response.json({ error: `"${v.name}" — 파일당 10MB까지 첨부할 수 있습니다` }, { status: 413 });
      }
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
