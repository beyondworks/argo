// Native init emits Tauri placeholder icons; keep phone icons aligned with the shipped desktop artwork.
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../src-tauri/', import.meta.url));
const platform = process.argv[2];
if (!['ios', 'android'].includes(platform)) throw new Error('Expected ios or android');
const target = join(root, platform === 'ios' ? 'gen/apple/Assets.xcassets/AppIcon.appiconset' : 'gen/android/app/src/main/res');
if (!existsSync(target)) throw new Error(`Initialize the ${platform} target first`);
if (platform === 'ios') {
  // Keep regenerated Xcode projects on the same supported OS baseline as Tauri.
  const minimum = JSON.parse(readFileSync(join(root, 'tauri.ios.conf.json'), 'utf8')).bundle.iOS.minimumSystemVersion;
  for (const [file, pattern, replacement] of [
    ['gen/apple/project.yml', /(iOS:) [\d.]+/, `$1 ${minimum}`],
    ['gen/apple/argo-messenger.xcodeproj/project.pbxproj', /(IPHONEOS_DEPLOYMENT_TARGET = )[^;]+/g, `$1${minimum}`],
  ]) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(pattern, replacement));
  }

  for (const file of readdirSync(join(root, 'icons/ios')).filter(file => file.endsWith('.png'))) {
    copyFileSync(join(root, 'icons/ios', file), join(target, file));
  }
} else {
  cpSync(join(root, 'icons/android'), target, { recursive: true });
}
