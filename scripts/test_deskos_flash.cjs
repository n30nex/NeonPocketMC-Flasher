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
  console.log('PASS: DeskOS app verification precedes boot selection; download/write failures never select or reset; clean install unchanged.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
