const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../flasher.js'), 'utf8');
const guard = source.slice(source.indexOf('async function verifyMeshGangsFlashHardware('), source.indexOf('async function flashEsp32('));
const flash = source.slice(source.indexOf('async function flashEsp32('), source.indexOf('async function flashUf2('));

async function run({ psram = 2, flashKiB = 16384, usbPid = 0x1001, start = 0x10000, capacity = 0x640000 } = {}) {
  const events = [];
  const partition = new Uint8Array(4096).fill(255);
  const table = new DataView(partition.buffer);
  table.setUint16(0, 0x50aa, true); table.setUint8(2, 0); table.setUint8(3, 0x10);
  table.setUint32(4, start, true); table.setUint32(8, capacity, true);
  class Loader {
    constructor() { this.chip = { CHIP_NAME: 'ESP32-S3', getPsramCap: async () => psram, getPsramVendor: async () => 'AP_3v3' }; }
    async main() {}
    async getFlashSize() { return flashKiB; } // Vendored loader reports KiB.
    async readFlash(address, length) { assert.equal(address, 0x8000); assert.equal(length, 0x1000); return partition; }
    async writeFlash(options) { assert.equal(options.eraseAll, false); assert.equal(options.fileArray[0].address, 0x10000); events.push('write'); }
    async flashMd5sum() { return 'a'.repeat(32); }
    async after() { events.push('reset'); }
  }
  const context = vm.createContext({
    DataView, state: { device: { id: 'heltec-v4', expected_chip: 'ESP32-S3' }, install: 'update', profile: {} },
    ESPLoader: Loader, Transport: class { async disconnect() {} },
    requestMatchingPort: async () => ({ getInfo: () => ({ usbVendorId: 0x303a, usbProductId: usbPid }) }),
    isMeshGangsSidecar: () => true, enrollMeshGangsDevice: async () => events.push('enroll'),
    setProgress() {}, flashLog() {}, sleep: async () => {}, bytesToBinaryString: () => '',
  });
  vm.runInContext(guard + flash, context);
  let error;
  try { await context.flashEsp32({ address: 0x10000, md5: 'a'.repeat(32) }, new Uint8Array(1300000)); }
  catch (caught) { error = caught; }
  return { events, error };
}

(async () => {
  const good = await run(); assert.equal(good.error, undefined); assert.deepEqual(good.events, ['enroll', 'write', 'reset']);
  for (const bad of [{ psram: 1 }, { psram: 0 }, { flashKiB: 8192 }, { usbPid: 0x1234 }, { start: 0x20000 }, { capacity: 1000000 }]) {
    const result = await run(bad); assert.ok(result.error); assert.deepEqual(result.events, []);
  }
  const roles = vm.createContext({ state: { profile: { roles: ['usb', 'wifi'] }, meshGangsRole: 'mobile' }, meshGangsRoles: new Set(['usb', 'wifi', 'mobile']) });
  vm.runInContext(source.slice(source.indexOf('function meshGangsAllowedRoles('), source.indexOf('function updateMeshGangsSetup(')), roles);
  assert.equal(roles.meshGangsInputsValid(), false);
  const route = vm.createContext({ state: {}, URLSearchParams, location: {search:'?role=wifi',hash:''}, meshGangsRoles: new Set(['usb','wifi','mobile']) });
  vm.runInContext(source.slice(source.indexOf('function captureMeshGangsEnrollment('), source.indexOf('function saveMeshGangsHandoff(')), route);
  route.captureMeshGangsEnrollment();
  assert.equal(route.state.meshGangsRole, 'wifi');
  console.log('PASS: V4 R8, wrong USB/flash and incompatible partitions stop before enrollment or writes; Mobile is rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
