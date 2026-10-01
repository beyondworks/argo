import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { SHIM_SRC } from '../src/no-dock.mjs';
import { stageCli } from '../scripts/stage-cli.mjs';

// Run the full staging scripts against disposable trees; build/archive/service
// commands and the runtime copy never touch the host installation.
function stage(kind, { esm = true, type = 'module', env = {} } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'argo-stage-no-dock-'));
  const put = (path, text) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text); };
  const original = esm ? "import './fixture.mjs';\nprocess.title = 'next-server fixture';\nglobalThis.nextStarted = true;\n" : 'require("next");';
  put(join(root, 'package.json'), '{"version":"fixture"}');
  put(join(root, '.next/standalone/package.json'), JSON.stringify({ type }));
  put(join(root, '.next/standalone/server.js'), original);
  put(join(root, '.next/standalone/fixture.mjs'), '');
  put(join(root, '.next/static/asset.js'), 'static fixture');
  put(join(root, 'public/asset.txt'), 'public fixture');
  put(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-fixture/cli'), 'fixture');
  put(join(root, 'docs/selfhost.md'), 'public installation guide');
  // argo CLI(서버 타르볼 3.5) — 실제 저장소처럼 src·bin·instrumentation-node가 있다
  put(join(root, 'src/cli/env.mjs'), 'export {};'); put(join(root, 'bin/argo.mjs'), '// cli fixture'); put(join(root, 'instrumentation-node.mjs'), 'export {};');
  put(join(root, '.next/standalone/docs/internal.md'), 'internal fixture');
  const commands = [];
  const source = fs.readFileSync(new URL(`../scripts/stage-${kind}.mjs`, import.meta.url), 'utf8')
    .replace(/^#!.*\n/, '').replace(/^import .* from .*;\n/gm, '').replaceAll('import.meta.url', "'file:///fixture'");
  const sandbox = {
    ...fs, SHIM_SRC, stageCli, dirname, join, fileURLToPath: () => join(root, 'scripts', `stage-${kind}.mjs`),
    process: { platform: 'darwin', arch: 'arm64', execPath: '/fixture/node', env, exit(code) { throw new Error(`exit:${code}`); } },
    copyFileSync: (from, to) => from === '/fixture/node' ? put(to, 'runtime fixture') : fs.copyFileSync(from, to),
    execFileSync: (file, args) => { commands.push([file, ...args]); if (file === 'rustc') return 'host: aarch64-apple-darwin\n'; if (file !== 'tar') throw new Error(`unexpected command: ${file}`); return ''; },
    console: { log() {}, error() {} },
  };
  const run = vm.runInNewContext(`(async () => { ${source} })()`, sandbox);
  return { root, original, commands, run, tree: kind === 'server' ? join(root, 'dist-server/argo-server') : join(root, 'src-tauri/resources/server') };
}

async function boot(tree, platform) {
  const context = vm.createContext({ process: { platform, title: 'original' } });
  const modules = new Map();
  const load = async (name) => {
    if (modules.has(name)) return modules.get(name);
    let module;
    if (name === './no-dock.cjs') {
      module = new vm.SyntheticModule([], () => vm.runInContext(fs.readFileSync(join(tree, name), 'utf8'), context), { context });
    } else {
      module = new vm.SourceTextModule(fs.readFileSync(join(tree, name), 'utf8'), {
        context,
        importModuleDynamically: async specifier => { const child = await load(specifier); await child.evaluate(); return child; },
      });
    }
    modules.set(name, module);
    await module.link(load);
    return module;
  };
  await (await load('./server.js')).evaluate();
  return context;
}

for (const kind of ['server', 'sidecar']) {
  test(`${kind}: staged bootstrap loads canonical shim before Next, keeps non-macOS titles and packaging`, async t => {
    const result = stage(kind);
    t.after(() => fs.rmSync(result.root, { recursive: true, force: true }));
    await result.run;
    assert.equal(fs.readFileSync(join(result.tree, 'no-dock.cjs'), 'utf8'), SHIM_SRC);
    assert.equal(fs.readFileSync(join(result.tree, 'server-next.mjs'), 'utf8'), result.original);
    const contexts = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
      import vm from 'node:vm';
      import * as fs from 'node:fs';
      import { join } from 'node:path';
      ${boot.toString()}
      const results = [];
      for (const platform of ['darwin', 'linux', 'win32']) results.push(await boot(process.argv[1], platform));
      console.log(JSON.stringify(results));
    `, result.tree], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    for (const context of contexts) {
      const platform = context.process.platform;
      assert.equal(context.nextStarted, true);
      assert.equal(context.process.title, platform === 'darwin' ? 'original' : 'next-server fixture');
    }
    assert.equal(fs.readFileSync(join(result.tree, '.next/static/asset.js'), 'utf8'), 'static fixture');
    assert.equal(fs.readFileSync(join(result.tree, 'public/asset.txt'), 'utf8'), 'public fixture');
    assert.equal(fs.existsSync(join(result.tree, 'node_modules/@anthropic-ai/claude-agent-sdk-fixture/cli')), true);
    assert.equal(fs.existsSync(join(result.tree, 'docs/internal.md')), false);
    assert.equal(fs.existsSync(join(result.tree, 'docs/selfhost.md')), kind === 'server');
    assert.equal(fs.existsSync(join(result.tree, 'bin/argo.mjs')) && fs.existsSync(join(result.tree, 'src/cli/env.mjs')), true, '서버 타르볼과 앱 사이드카 모두 argo CLI가 실린다(앱을 설치하면 argo가 따라온다)');
    assert.equal(fs.existsSync(join(result.tree, 'bin/argo-public.json')), false, 'Supabase 공개 설정이 없으면 만들지 않는다');
    assert.deepEqual(result.commands.map(command => command[0]), [kind === 'server' ? 'tar' : 'rustc']);
  });

  for (const options of [{ esm: false }, { type: 'commonjs' }]) {
    test(`${kind}: incompatible standalone format rejects staging ${JSON.stringify(options)}`, async t => {
      const result = stage(kind, options);
      t.after(() => fs.rmSync(result.root, { recursive: true, force: true }));
      await assert.rejects(result.run, /exit:1/);
      assert.equal(fs.existsSync(join(result.tree, 'server-next.mjs')), false);
      assert.equal(result.commands.some(command => command[0] === 'tar'), false);
    });
  }
}

// 공개 Supabase 설정(URL·anon 키)을 구워 두면 계정 로그인이 된다. 서버 타르볼은 CLI 전용 이름만 받는다(NEXT_PUBLIC_*는 Next 빌드에 인라인돼 셀프호스트 웹이 인증 모드가 된다), 사이드카는 이미 앱 빌드에 쓰는 NEXT_PUBLIC_* 값을 쓴다.
for (const [kind, names, other] of [['server', ['ARGO_CLI_SUPABASE_URL', 'ARGO_CLI_SUPABASE_ANON_KEY'], ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']], ['sidecar', ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'], ['ARGO_CLI_SUPABASE_URL', 'ARGO_CLI_SUPABASE_ANON_KEY']]]) {
  test(`${kind}: argo-public.json은 ${names[0]}로만 만든다`, async t => {
    const mine = stage(kind, { env: { [names[0]]: 'https://sb.example', [names[1]]: 'anon-public' } });
    const foreign = stage(kind, { env: { [other[0]]: 'https://sb.example', [other[1]]: 'anon-public' } });
    t.after(() => { fs.rmSync(mine.root, { recursive: true, force: true }); fs.rmSync(foreign.root, { recursive: true, force: true }); });
    await mine.run; await foreign.run;
    assert.deepEqual(JSON.parse(fs.readFileSync(join(mine.tree, 'bin/argo-public.json'), 'utf8')), { url: 'https://sb.example', anonKey: 'anon-public' });
    assert.equal(fs.existsSync(join(foreign.tree, 'bin/argo-public.json')), false);
  });
}
