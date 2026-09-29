import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const root = fileURLToPath(new URL('../design/app-icon/', import.meta.url));
const source = await readFile(path.join(root, 'office.svg'), 'utf8');
const inner = source.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const mac = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs><clipPath id="tile"><rect width="1024" height="1024" rx="224"/></clipPath>
<filter id="shadow" x="-25%" y="-25%" width="150%" height="160%"><feGaussianBlur stdDeviation="12"/></filter></defs>
<rect x="96" y="110" width="832" height="832" rx="182" fill="#211b13" opacity="0.24" filter="url(#shadow)"/>
<g transform="translate(96 96) scale(0.8125)" clip-path="url(#tile)">${inner}</g>
<rect x="97" y="97" width="830" height="830" rx="181" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="2"/>
</svg>`;
await mkdir(path.join(root, 'macOS/ArgoOffice.iconset'), { recursive: true });
await mkdir(path.join(root, 'iOS/Assets.xcassets/AppIcon.appiconset'), { recursive: true });
await writeFile(path.join(root, 'office-macos.svg'), mac);
for (const [svg, png] of [['office.svg', 'iOS/ArgoOffice-1024.png'], ['office-macos.svg', 'macOS/ArgoOffice-1024.png']]) {
  execFileSync('rsvg-convert', ['-w', '1024', '-h', '1024', '-o', path.join(root, png), path.join(root, svg)]);
}
const iosMaster = await sharp(path.join(root, 'iOS/ArgoOffice-1024.png')).flatten({ background: '#f3eee4' }).removeAlpha().png().toBuffer();
await writeFile(path.join(root, 'iOS/ArgoOffice-1024.png'), iosMaster);
const macMaster = await readFile(path.join(root, 'macOS/ArgoOffice-1024.png'));
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp(macMaster).resize(size * scale).png().toFile(path.join(root, `macOS/ArgoOffice.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
  }
}
execFileSync('iconutil', ['-c', 'icns', path.join(root, 'macOS/ArgoOffice.iconset'), '-o', path.join(root, 'macOS/ArgoOffice.icns')]);
const images = [];
for (const [idiom, sizes, scales] of [['iphone', [20, 29, 40, 60], [2, 3]], ['ipad', [20, 29, 40, 76], [1, 2]], ['ipad', [83.5], [2]], ['ios-marketing', [1024], [1]]]) {
  for (const size of sizes) for (const scale of scales) {
    const filename = `icon-${idiom}-${size}@${scale}x.png`;
    await sharp(iosMaster).resize(Math.round(size * scale)).removeAlpha().png().toFile(path.join(root, 'iOS/Assets.xcassets/AppIcon.appiconset', filename));
    images.push({ idiom, size: `${size}x${size}`, scale: `${scale}x`, filename });
  }
}
await writeFile(path.join(root, 'iOS/Assets.xcassets/AppIcon.appiconset/Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'xcode' } }, null, 2) + '\n');
await writeFile(path.join(root, 'iOS/Assets.xcassets/Contents.json'), JSON.stringify({ info: { version: 1, author: 'xcode' } }, null, 2) + '\n');
const native = fileURLToPath(new URL('../src-tauri/icons/office/', import.meta.url));
await mkdir(native, { recursive: true });
await copyFile(path.join(root, 'macOS/ArgoOffice.icns'), path.join(native, 'icon.icns'));
for (const [filename, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256]]) {
  await sharp(macMaster).resize(size).png().toFile(path.join(native, filename));
}
console.log(`Created macOS ICNS/iconset and 18 iOS catalog slots at ${root}`);
