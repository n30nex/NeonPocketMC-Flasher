const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../flasher.js'), 'utf8');
const flashFunction = source.slice(source.indexOf('async function flashEsp32('), source.indexOf('async function flashUf2('));
const app = { address: 0x20000, md5: 'a'.repeat(32) };
const boot = { address: 0xf000, size: 8192, md5: 'b'.repeat(32) };

async function run({ badApp = false, badBoot = false, badDownload = false, missingBoot = false, install = 'update' } = {}) {
  const events = [];
  class Loader {
    constructor() { this.chip = { CHIP_NAME: 'ESP32-S3' }; }
    async main() {}
    async writeFlash(options) {
      assert.equal(options.eraseAll, false);
      assert.equal(options.flashSize, 'keep');
      events.push(['write', options.fileArray[0].address]);
    }
    async flashMd5sum(address) {
      events.push(['verify', address]);
      return address === 0xf000 ? (badBoot ? '0'.repeat(32) : boot.md5) : (badApp ? '0'.repeat(32) : app.md5);
    }
    async after() { events.push(['reset']); }
  }
  const context = vm.createContext({
    state: { device: { id: 'deskos-d1l', expected_chip: 'ESP32-S3' }, install, profile: { update_boot: missingBoot ? null : boot } },
    ESPLoader: Loader,
    Transport: class { async disconnect() {} },
    requestMatchingPort: async () => { events.push(['usb']); return {}; },
    fetchFirmware: async () => { if (badDownload) throw new Error('SHA-256 mismatch'); return new Uint8Array(8192).fill(255); },
    bytesToBinaryString: (bytes) => String.fromCharCode(...bytes),
    isMeshGangsSidecar: () => false,
    setProgress() {}, flashLog() {}, sleep: async () => {},
  });
  vm.runInContext(flashFunction, context);
  let error;
  try { await context.flashEsp32(install === 'recovery' ? { ...app, address: 0 } : app, new Uint8Array(32)); }
  catch (caught) { error = caught; }
  return { events, error };
}

async function checkSelectionLock(failDownload) {
  const panels = [{inert:false}, {inert:false}, {inert:false}];
  const button = {disabled:false};
  const state = {device:{id:'deskos-d1l',flash_method:'esp32'},profile:{id:'candidate'},install:'update'};
  let finishDownload;
  const downloaded = new Promise((resolve, reject) => { finishDownload = () => failDownload ? reject(new Error('download failed')) : resolve(new Uint8Array(1)); });
  let flashes = 0, completed = 0;
  const context = vm.createContext({state, navigator:{serial:{}}, $:()=>button, $$:()=>panels,
    enableThrough() {}, resetLog() {}, playModem() {}, setProgress() {}, flashLog() {},
    isMeshGangsSidecar:()=>false, currentArtifact:()=>app, fetchFirmware:()=>downloaded,
    flashEsp32:async()=>{ flashes++; assert.equal(state.device.id,'deskos-d1l'); assert.equal(state.profile.id,'candidate'); assert.equal(state.install,'update'); },
  });
  const functionSource = (name) => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0);
    const next = source.slice(start + 1).search(/\n(?:async )?function /);
    return source.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  for (const name of ['flashSelected','goToStep','showDeviceFamilies','selectDevice','selectProfile','selectInstallMode']) {
    vm.runInContext(functionSource(name), context);
  }
  const pending = context.flashSelected();
  assert.equal(state.flashing,true);
  assert.ok(panels.every(panel=>panel.inert));
  context.showDeviceFamilies(); context.selectDevice('other'); context.selectProfile('other');
  context.selectInstallMode('recovery'); context.goToStep(1);
  await context.flashSelected(); // A second click cannot start another download/write.
  assert.equal(state.device.id,'deskos-d1l'); assert.equal(state.profile.id,'candidate');
  assert.equal(state.install,'update');
  context.goToStep=()=>{completed++; assert.equal(state.flashing,false);};
  finishDownload();
  await pending;
  assert.equal(state.flashing,false);
  assert.ok(panels.every(panel=>!panel.inert));
  assert.equal(button.disabled,false);
  assert.equal(flashes, failDownload ? 0 : 1);
  assert.equal(completed, failDownload ? 0 : 1);
}

(async () => {
  const good = await run();
  assert.equal(good.error, undefined);
  assert.deepEqual(good.events, [['usb'], ['write', 0x20000], ['verify', 0x20000], ['write', 0xf000], ['verify', 0xf000], ['reset']]);
  const badApp = await run({ badApp: true });
  assert.match(badApp.error.message, /MD5 mismatch/);
  assert.deepEqual(badApp.events, [['usb'], ['write', 0x20000], ['verify', 0x20000]]);
  const badBoot = await run({ badBoot: true });
  assert.match(badBoot.error.message, /boot selection verification failed/);
  assert.equal(badBoot.events.some(([event]) => event === 'reset'), false);
  for (const options of [{ badDownload: true }, { missingBoot: true }]) {
    const stopped = await run(options);
    assert.ok(stopped.error);
    assert.deepEqual(stopped.events, []);
  }
  const recovery = await run({ install: 'recovery', missingBoot: true });
  assert.equal(recovery.error, undefined);
  assert.deepEqual(recovery.events, [['usb'], ['write', 0], ['verify', 0], ['reset']]);
  await checkSelectionLock(false);
  await checkSelectionLock(true);
  console.log('PASS: DeskOS app verification precedes boot selection; download/write failures never select or reset; clean install unchanged.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
