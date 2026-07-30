import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCrewContext,
  encodeCrewContext,
  makeCrewActions,
  normalizeCrewContext,
} from '../src/crew-actions.mjs';

const context = {
  wsId: 'company-1',
  fromSlug: 'master',
  fromName: '마스터',
  colleagues: [
    { slug: 'sw-cto', name: 'SW CTO', role: '기술 총괄' },
    { slug: 'researcher', name: '리서처' },
  ],
  hop: 0,
  chain: [],
  mirrorCtx: { source: 'web' },
  lang: 'ko',
};

test('Codex MCP용 크루 context는 왕복 후 허용 범위만 유지한다', () => {
  const decoded = decodeCrewContext(encodeCrewContext(context));
  assert.deepEqual(decoded, normalizeCrewContext(context));
  assert.throws(
    () => normalizeCrewContext({ ...context, colleagues: [...context.colleagues, context.colleagues[0]] }),
    /duplicate colleague/,
  );
  assert.throws(() => decodeCrewContext('../../etc/passwd'), /invalid encoded/);
});

test('delegate는 허용된 Argo 동료에게만 hop/chain을 전달하고 턴당 2회로 제한한다', async () => {
  const calls = [];
  const turns = [];
  const notifications = [];
  const actions = makeCrewActions(context, {
    runChat: async (...args) => {
      calls.push(args);
      return { reply: `확인 ${calls.length}`, handover: { rel: `h${calls.length}.md` } };
    },
    appendTurn: async (...args) => { turns.push(args); },
    emitNotify: (event) => { notifications.push(event); },
  });

  const first = await actions.delegate({ to: 'SW CTO', task: '각 SW 크루에게 확인해 취합해줘' });
  const second = await actions.delegate({ to: 'researcher', task: '관련 근거를 확인해줘' });
  const third = await actions.delegate({ to: 'sw-cto', task: '세 번째 요청' });

  assert.match(first, /SW CTO의 작업 결과/);
  assert.match(second, /리서처의 작업 결과/);
  assert.match(third, /위임 한도 초과/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'company-1');
  assert.equal(calls[0][1], 'sw-cto');
  assert.deepEqual(calls[0][4], { from: 'master', hop: 1, chain: ['master'] });
  assert.match(calls[0][2], /^\(동료 마스터의 위임\)/);
  assert.equal(turns.length, 2);
  assert.equal(notifications[0].to, 'sw-cto');
  assert.deepEqual(notifications[0].ctx, { source: 'web' });
});

test('send_to_crew는 허용 동료와 cc만 큐에 넣고 성공한 쪽지만 상한에 센다', async () => {
  const sent = [];
  const actions = makeCrewActions(context, {
    runChat: async () => ({ reply: '' }),
    sendCrewMail: async (wsId, mail) => {
      sent.push({ wsId, mail });
      return `mail-${sent.length}`;
    },
  });

  const unknown = await actions.sendToCrew({ to: 'outsider', message: '안녕' });
  const first = await actions.sendToCrew({ to: 'sw-cto', cc: ['researcher', 'outsider'], message: '확인 요청' });
  const second = await actions.sendToCrew({ to: 'researcher', message: '자료 요청' });
  const third = await actions.sendToCrew({ to: 'sw-cto', message: '세 번째' });

  assert.match(unknown, /동료 명단에 없다/);
  assert.match(first, /mail-1/);
  assert.match(second, /mail-2/);
  assert.match(third, /쪽지 한도 초과/);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].mail.cc, ['researcher']);
  assert.equal(sent[0].mail.hop, 1);
  assert.deepEqual(sent[0].mail.chain, ['master']);
});
