#!/usr/bin/env node
// install.src.ps1(원본, 한글) → install.ps1(배포본, ASCII만). Windows PowerShell 5.1은 `irm … | iex`로 받은 UTF-8을 잘못 읽어
// 한글이 깨지고, 깨진 바이트 0x85(NEL)는 줄바꿈으로 읽혀 주석 뒤 글자가 코드가 될 수 있다. 그래서 배포본은 ASCII만 쓴다:
// 주석 줄은 빼고, 한글 묶음은 `$([regex]::Unescape('\uXXXX'))`로 바꾼다(원본 규칙: 한글은 큰따옴표 문자열 안에만).
// test/install-ps1.test.mjs가 배포본이 원본과 같은지·ASCII만인지 확인한다 — 원본을 고치면 이 스크립트를 다시 실행한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export function buildInstallPs1(src) {
  const esc = (run) => `$([regex]::Unescape('${Array.from({ length: run.length }, (_, k) => `\\u${run.charCodeAt(k).toString(16).padStart(4, '0')}`).join('')}'))`; // UTF-16 코드 단위 그대로(서로게이트 쌍도 두 개의 \u)
  const body = src.replace(/\r\n/g, '\n').split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .map((l) => l.replace(/\s+#\s[^'"]*$/, (c) => (/[^\x00-\x7f]/.test(c) ? '' : c))) // 끝에 붙은 한글 주석은 뺀다
    .map((l) => l.replace(/[^\x00-\x7f]+(?: +[^\x00-\x7f]+)*/g, esc)) // 띄어쓰기로 이어진 한글은 한 묶음으로
    .join('\r\n');
  return `# Argo argo CLI installer for Windows (generated from scripts/install.src.ps1 by scripts/build-install-ps1.mjs - do not edit)\r\n# Usage (PowerShell): irm https://github.com/beyondworks/argo-agent/releases/latest/download/install.ps1 | iex\r\n${body}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = buildInstallPs1(readFileSync(resolve(HERE, 'install.src.ps1'), 'utf8'));
  writeFileSync(resolve(HERE, 'install.ps1'), out);
  console.log(`[build-install-ps1] scripts/install.ps1 (${out.length} bytes, ASCII)`);
}
