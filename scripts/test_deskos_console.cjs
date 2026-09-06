const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../flasher.js'), 'utf8');
function between(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const elements = new Map(), logs = [];
const state = { device: { id: 'deskos-d1l', commit: 'a'.repeat(40), tag: 'v1.8.0-rc.1' }, install: 'update' };
let clock = 0;
const context = vm.createContext({
  setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array,
  performance: { now: () => clock }, state,
  serialLog: (line) => logs.push(line), deskosLog: (line) => logs.push(line), resetLog() {},
  $: (id) => {
    if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(id);
  },
});
vm.runInContext(between('class CliSession', 'async function connectConsole'), context);
vm.runInContext(between('function setDeskOsSetupState', 'async function disconnectDeskOsConsole'), context);
vm.runInContext(between('function parseCliJson', 'async function verifyBoot'), context);
vm.runInContext(between('function portMatchesDevice', 'function usbFilters'), context);
const CliSession = vm.runInContext('CliSession', context);
function session(jsonReplies = true) {
  const cli = new CliSession({}, { jsonReplies });
  cli.running = true;
  cli.writer = { write: async () => {}, releaseLock() {} };
  return cli;
}
const version = { schema: 1, ok: true, cmd: 'version', firmware: 'MeshCore DeskOS D1L', version: '1.8.0-rc.1', build_commit: state.device.commit, release_profile: 'full_feature' };
const health = { schema: 1, ok: true, cmd: 'health', board_ready: true, ui_ready: true, build_commit: state.device.commit };
const mesh = { schema: 1, ok: true, cmd: 'mesh status', radio_ready: true, identity_ready: true, companion_framing_ready: true, build_commit: state.device.commit };
const storage = { schema: 1, ok: true, cmd: 'storage status', build_commit: state.device.commit, data_enabled: true,
  retained_sd: {degraded:false,backup_degraded:false},
  sd: { rp2040_bridge_ready: true, rp2040_protocol_supported: true, present: true, mounted: true,
    data_root_ready: true, file_ops: true, filesystem: 'fat32', status_stale: false, presence_stale: false } };

(async () => {
  const cli = session();
  const waiting = cli.command('version');
  const request = cli.waiter;
  cli.onLine(JSON.stringify({ schema: 1, ok: true, cmd: 'help' }));
  cli.onLine(JSON.stringify(health));
  cli.onLine(JSON.stringify({ schema: 1, ok: true, cmd: {} }));
  assert.equal(cli.waiter, request, 'boot help and stale replies cannot satisfy a different command');
  cli.onLine('DeskOS> ' + JSON.stringify(version));
  assert.equal(JSON.parse(await waiting).build_commit, state.device.commit);
  const subcommand = cli.command('ui tab home');
  cli.onLine('{"schema":1,"ok":true,"cmd":"ui tab"}');
  assert.equal(JSON.parse(await subcommand).cmd, 'ui tab');

  const legacy = session(false);
  const legacyReply = legacy.command('get name');
  legacy.onLine(JSON.stringify(version));
  assert.ok(legacy.waiter);
  legacy.onLine('-> legacy radio');
  assert.equal(await legacyReply, 'legacy radio');
  logs.length = 0;
  const hidden = legacy.command('set password fixture-secret', { secret: true });
  legacy.onLine('echo fixture-secret');
  legacy.onLine('-> ERROR fixture-secret');
  await assert.rejects(hidden, /secret setting was rejected/);
  assert.equal(logs.some((line) => line.includes('fixture-secret')), false);

  let rejectOldWrite;
  const stalled = session();
  stalled.writer.write = () => new Promise((_resolve, reject) => { rejectOldWrite = reject; });
  await assert.rejects(stalled.command('version', { timeout: 1 }), (error) => error.code === 'CLI_TIMEOUT');
  stalled.writer.write = async () => {};
  const next = stalled.command('health');
  rejectOldWrite(new Error('late write failure'));
  await Promise.resolve();
  assert.equal(stalled.waiter.command, 'health');
  stalled.onLine(JSON.stringify(health));
  await next;
  const unplugged = session();
  unplugged.reader = { read: async () => ({ done: true }) };
  const lost = assert.rejects(unplugged.command('version'), /disconnected/);
  await unplugged.readLoop(); await lost;
  assert.equal(unplugged.running, false);

  let attempts = 0, connections = 0, disconnects = 0;
  const bootCli = {
    async command(command, options) {
      if (command === 'version' && ++attempts <= 2) {
        clock += options.timeout;
        throw Object.assign(new Error('loading'), { code: 'CLI_TIMEOUT' });
      }
      return JSON.stringify(command === 'version' ? version : command === 'health' ? health : command === 'mesh status' ? mesh : storage);
    }, async disconnect() { disconnects++; },
  };
  context.connectConsole = async () => { connections++; state.cli = bootCli; return bootCli; };
  await context.verifyDeskOsIdentity({});
  assert.equal(connections, 1, 'slow startup must not reopen/reset the device');
  assert.equal(state.deskosVerified.version.version, '1.8.0-rc.1');
  assert.equal(context.deskOsStorageReadiness(storage).sdReady, true);
  assert.equal(context.deskOsStorageReadiness({...storage,retained_sd:undefined}).sdReady,false);
  const degraded={...storage,retained_sd:{degraded:true,backup_degraded:false}};
  assert.equal(context.deskOsStorageReadiness(degraded).sdReady,false);
  context.reflectDeskOsStorage(degraded);
  assert.equal(elements.get('#deskos-sd-state').textContent,'History needs attention');
  assert.equal(elements.get('#deskos-required-action').textContent,'Recheck storage');
  assert.equal(context.deskOsStorageReadiness({ ...storage, sd: { ...storage.sd, status_stale: true } }).sdReady, false);
  assert.equal(context.deskOsStorageReadiness({ ...storage, ok: false }).bridgeReady, false);
  state.install = 'recovery';
  context.updateDeskOsCompletion({ bridgeReady: true, sdReady: false });
  assert.equal(elements.get('#deskos-success-mark').textContent, '!');
  state.install = 'update';
  context.updateDeskOsCompletion();
  assert.equal(elements.get('#deskos-install-title').textContent, 'DeskOS update complete');
  state.deskosVerified = null;
  context.updateDeskOsCompletion({ bridgeReady: true, sdReady: true });
  assert.equal(elements.get('#deskos-success-mark').textContent, '!');
  health.build_commit = 'b'.repeat(40);
  await assert.rejects(context.verifyDeskOsIdentity({}), /changed builds/);
  assert.equal(state.deskosVerified, null);
  assert.equal(disconnects, 1);

  clock = 0;
  await assert.rejects(context.waitForDeskOsVersion({ async command(_cmd, options) {
    clock += options.timeout;
    throw Object.assign(new Error('not ready'), { code: 'CLI_TIMEOUT' });
  } }), /two minutes/);
  assert.equal(clock, 120000);
  const device = { id: 'deskos-d1l', usb_vid: 6790, usb_pid: 29987 };
  assert.equal(context.portMatchesDevice({ getInfo: () => ({}) }, device), false);
  assert.equal(context.portMatchesDevice({ getInfo: () => ({ usbVendorId: 6790, usbProductId: 29987 }) }, device), true);
  console.log('PASS: real DeskOS JSON correlation, slow startup, disconnect/timeout cleanup, secret redaction, storage shape and install gates.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
