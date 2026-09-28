import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { noDockMcpEnv } from './no-dock.mjs';

/** SDK deletes NODE_OPTIONS before spawning its CLI. Restore only the adopted Argo
 * preload at its supported spawn boundary, so Node commands run by Bash inherit it.
 * Capture before query(): SDK versions may mutate the supplied environment object.
 * Non-macOS / inactive preload keeps the SDK's own transport unchanged.
 */
export function sdkNoDockOptions({ stderr, parentEnv = process.env, spawnFn = spawn, ...noDock } = {}) {
  const adopted = noDockMcpEnv(undefined, { ...noDock, parentEnv: { ...parentEnv } });
  if (!adopted) return {};
  return {
    spawnClaudeCodeProcess({ command, args, cwd, env, signal }) {
      const child = spawnFn(command, args, {
        cwd, env: noDockMcpEnv(env, { ...noDock, parentEnv: adopted }), signal,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      // Match local SDK transport's 200ms stderr-drain grace, including UTF-8
      // boundaries. Custom transports must forward the stderr callback themselves.
      // SDK's private redacted stderr tail/debug-file facility is not exposed by
      // this hook; do not recreate it with an unredacted error or console dump.
      const proc = new EventEmitter();
      const decoder = new StringDecoder('utf8');
      let exited = false; let drained = false; let delivered = false; let timer;
      const deliver = () => {
        if (delivered) return;
        delivered = true;
        clearTimeout(timer);
        proc.emit('exit', child.exitCode, child.signalCode);
        child.stderr.destroy();
      };
      child.stderr.on('data', data => { if (!delivered) stderr?.(decoder.write(data)); });
      child.stderr.on('error', () => { /* Exit/code remains the diagnostic authority. */ });
      child.stderr.once('close', () => {
        if (!delivered) { const rest = decoder.end(); if (rest) stderr?.(rest); }
        drained = true;
        if (exited) deliver();
      });
      child.once('exit', () => {
        exited = true;
        if (drained) deliver(); else timer = setTimeout(deliver, 200);
      });
      child.on('error', err => proc.emit('error', err));
      Object.assign(proc, { stdin: child.stdin, stdout: child.stdout, kill: child.kill.bind(child) });
      for (const key of ['killed', 'exitCode', 'signalCode']) {
        Object.defineProperty(proc, key, { get: () => child[key] });
      }
      return proc;
    },
  };
}
