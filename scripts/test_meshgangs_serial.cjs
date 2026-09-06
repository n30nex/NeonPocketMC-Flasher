const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../flasher.js'), 'utf8');
const exchange = source.slice(source.indexOf('async function exchangeMeshGangsSerial('), source.indexOf('async function provisionMeshGangs('));
const identityReply = 'MG1 INFO meshgangs-v4 v0.1.0-beta.24\r\n';

function runtime(onWrite, { timed = false } = {}) {
  let clock = 0;
  let pending;
  const queue = [];
  const writes = [];
  const lifecycle = [];
  function deliver(...chunks) {
    queue.push(...chunks.map(value => ({ value: new TextEncoder().encode(value), done: false })));
    if (pending && queue.length) { const resolve = pending; pending = null; resolve(queue.shift()); }
  }
  const port = {
    async open() { lifecycle.push('open'); },
    async close() { lifecycle.push('close'); },
    writable: { getWriter: () => ({
      async write(bytes) { const text = new TextDecoder().decode(bytes); writes.push(text); onWrite?.(text, writes.length, deliver); },
      releaseLock() { lifecycle.push('writer released'); },
    }) },
    readable: { getReader: () => ({
      read() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => { pending = resolve; }); },
      async cancel() { if (pending) pending({ done: true }); lifecycle.push('cancel'); },
      releaseLock() { lifecycle.push('reader released'); },
    }) },
  };
  const context = vm.createContext({
    TextDecoder, TextEncoder, Date: timed ? { now: () => clock } : Date,
    sleep: timed ? async ms => { clock += ms; } : () => new Promise(() => {}),
    state: { profile: { tag: 'v0.1.0-beta.24' } },
  });
  vm.runInContext(exchange, context);
  return { context, port, writes, lifecycle };
}

(async () => {
  // Every USB split, including the middle of the version, must preserve the full reply.
  for (let split = 1; split < identityReply.length; split++) {
    const r = runtime((_text, _count, deliver) => deliver(identityReply.slice(0, split), identityReply.slice(split)));
    const reply = await r.context.exchangeMeshGangsSerial(r.port, 'CMD:MG1:INFO', /MG1 INFO [^\r\n]+/);
    assert.equal(reply, identityReply, `version reply returned prematurely at byte ${split}`);
    assert.deepEqual(r.lifecycle, ['open', 'cancel', 'reader released', 'writer released', 'close']);
  }

  for (const command of ['CMD:MG1:INFO', 'CMD:mgstatus:']) {
    const answer = command.endsWith('INFO') ? identityReply : 'MeshGangs status: READY version=v0.1.0-beta.24 role=1\r\n';
    const r = runtime((_text, count, deliver) => { if (count === 2) deliver(answer); }, { timed: true });
    const reply = await r.context.exchangeMeshGangsSerial(r.port, command, /MG1 INFO|MeshGangs status:/, 6000);
    assert.equal(reply, answer);
    assert.equal(r.writes.length, 2, 'read-only query must recover if startup dropped the first request');
  }

  const secretCommand = 'CFG:MG1:WIFI:synthetic:synthetic:' + 'ab'.repeat(32);
  const r = runtime(() => {}, { timed: true });
  await assert.rejects(r.context.exchangeMeshGangsSerial(r.port, secretCommand, /RSP:mgprovision:/, 4000));
  assert.equal(r.writes.length, 1, 'never retransmit provisioning credentials automatically');

  const helper = source.slice(source.indexOf('function meshGangsStartupFailure('), source.indexOf('async function exchangeMeshGangsSerial('));
  const context = vm.createContext({}); vm.runInContext(helper, context);
  const retry = 'SX1262 init failed (-707); retrying without TCXO control\r\n';
  const ready = 'MeshCore client ready: 910.525 MHz, BW 62.5 kHz, SF7, CR 4/5, TX 22dBm\r\n';
  assert.equal(context.meshGangsStartupFailure(retry + ready), null);
  assert.ok(context.meshGangsStartupFailure(retry), 'a retry without successful startup is not healthy');
  assert.ok(context.meshGangsStartupFailure(ready + retry), 'an earlier ready line cannot excuse a later failure');
  for (const fatal of ['ERROR: SX1262 init failed: -707', 'ERROR: SX1262 configuration failed: -1', 'ERROR: board-specific SX1262 configuration failed', 'ERROR: MeshCore client failed to start', 'ERROR: SSD1306 display failed to start', 'storage layout error', 'Guru Meditation Error', 'assert failed']) {
    assert.ok(context.meshGangsStartupFailure(retry + ready + fatal + '\r\n'), fatal);
  }

  const identity = source.slice(source.indexOf('async function verifyMeshGangsIdentity('), source.indexOf('async function provisionMeshGangs('));
  for (const reply of [identityReply, 'MG1 INFO meshgangs-v3 v0.1.0-beta.24\r\n', 'MG1 INFO meshgangs-v4 v0.1.0-beta.23\r\n', 'MG1 INFO meshgangs-v4 v0.1.0-beta.24-extra\r\n']) {
    const test = vm.createContext({ state: { profile: { tag: 'v0.1.0-beta.24' } }, exchangeMeshGangsSerial: async () => reply });
    vm.runInContext(identity, test);
    if (reply === identityReply) await test.verifyMeshGangsIdentity({});
    else await assert.rejects(test.verifyMeshGangsIdentity({}), /did not confirm/);
  }
  console.log('PASS: fragmented replies, startup retries, single-send credentials, strict identity and real hardware failure checks.');
})().catch(error => { console.error(error); process.exitCode = 1; });
