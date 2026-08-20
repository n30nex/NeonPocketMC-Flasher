import { ESPLoader, Transport } from "/lib/esp32.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  catalog: null,
  device: null,
  profile: null,
  install: "update",
  maxStep: 1,
  port: null,
  cli: null,
  deskosVerified: null,
  deskosSdBundle: null,
  deskosBridgeSent: false,
  deskosSdPrepared: false,
  stepperTop: null,
};

const flashLog = (text) => appendLog($("#flash-log"), text);
const bootLog = (text) => appendLog($("#boot-log"), text);
const serialLog = (text) => appendLog($("#serial-log"), text);
const deskosLog = (text) => appendLog($("#deskos-log"), text);

function appendLog(element, text) {
  const line = String(text ?? "").replace(/\r/g, "");
  element.textContent += `${element.textContent.endsWith("\n") || !element.textContent ? "" : "\n"}${line}`;
  element.scrollTop = element.scrollHeight;
}

function resetLog(element, text) {
  element.textContent = text;
  element.scrollTop = element.scrollHeight;
}

function setProgress(stage, percent) {
  $("#flash-progress").classList.remove("hidden");
  $("#progress-stage").textContent = stage;
  $("#progress-number").textContent = `${Math.round(percent)}%`;
  $("#progress-bar").value = percent;
}

function enableThrough(step) {
  state.maxStep = Math.max(state.maxStep, step);
  $$(".step").forEach((button, index) => {
    const number = index + 1;
    button.disabled = number > state.maxStep;
    button.classList.toggle("done", number < step && number <= state.maxStep);
  });
}

function goToStep(step) {
  if (step > state.maxStep) return;
  $$(".panel").forEach((panel) => panel.classList.toggle("active", Number(panel.dataset.panel) === step));
  $$(".step").forEach((button) => button.classList.toggle("active", Number(button.dataset.go) === step));
  const top = state.stepperTop ?? $(".stepper").offsetTop;
  window.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function renderDevices() {
  $("#device-grid").innerHTML = state.catalog.devices.map((device) => `
    <button class="device-card" data-device="${escapeHtml(device.id)}">
      <span class="card-kicker">${escapeHtml(device.family)}</span>
      <h3>${escapeHtml(device.name)}</h3>
      <p>${escapeHtml(device.display)}</p>
      <div class="tags"><span class="tag">${device.profiles.length} build${device.profiles.length === 1 ? "" : "s"}</span><span class="tag">${device.flash_method === "esp32" ? "Web Serial" : "UF2"}</span></div>
    </button>
  `).join("");
  $$("[data-device]").forEach((card) => card.addEventListener("click", () => selectDevice(card.dataset.device)));
}

function selectDevice(id) {
  state.device = state.catalog.devices.find((device) => device.id === id);
  state.profile = null;
  state.install = "update";
  state.deskosVerified = null;
  state.deskosSdBundle = null;
  state.deskosBridgeSent = false;
  state.deskosSdPrepared = false;
  $$("[data-device]").forEach((card) => card.classList.toggle("selected", card.dataset.device === id));
  $("#selected-device-copy").textContent = `${state.device.name} · ${state.device.display}`;
  renderProfiles();
  enableThrough(2);
  goToStep(2);
}

function renderProfiles() {
  $("#profile-grid").innerHTML = state.device.profiles.map((profile) => `
    <button class="profile-card" data-profile="${escapeHtml(profile.id)}">
      <span class="card-kicker">${escapeHtml(profile.transport)}</span>
      <h3>${escapeHtml(profile.name)}</h3>
      <p>${escapeHtml(profile.summary)}</p>
      <div class="tags">${profile.features.map((feature) => `<span class="tag">${escapeHtml(feature)}</span>`).join("")}</div>
    </button>
  `).join("");
  $$("[data-profile]").forEach((card) => card.addEventListener("click", () => selectProfile(card.dataset.profile)));
  $("#install-mode").classList.add("hidden");
  $("#deskos-clean-confirm").classList.add("hidden");
  $("#ambiguous-confirm").classList.add("hidden");
  $("#to-flash").disabled = true;
}

function selectProfile(id) {
  state.profile = state.device.profiles.find((profile) => profile.id === id);
  $$("[data-profile]").forEach((card) => card.classList.toggle("selected", card.dataset.profile === id));
  const hasRecovery = Boolean(state.profile.recovery);
  const deskos = state.device.id === "deskos-d1l";
  $("#install-mode").classList.toggle("hidden", !hasRecovery);
  $("#ambiguous-confirm").classList.toggle("hidden", !state.device.ambiguous_with);
  $("#update-mode-title").textContent = deskos ? "Update DeskOS" : "Update";
  $("#update-mode-copy").textContent = deskos ? "Keeps the existing DeskOS identity, contacts, settings, and history." : "Preserves identity and settings.";
  $("#recovery-mode-title").textContent = deskos ? "Fresh clean install" : "Recovery";
  $("#recovery-mode-copy").textContent = deskos ? "Installs a new ESP32 image, then requires the RP2040 bridge and FAT32 SD card." : "Preserves MeshCore storage. Resets NVS and BLE bonds.";
  $("#model-confirm").checked = false;
  $("#deskos-clean-checkbox").checked = false;
  state.install = "update";
  const updateRadio = $('input[name="install"][value="update"]');
  if (updateRadio) updateRadio.checked = true;
  updateContinueState();
}

function updateContinueState() {
  const deskosClean = state.device?.id === "deskos-d1l" && state.install === "recovery";
  $("#deskos-clean-confirm").classList.toggle("hidden", !deskosClean);
  $("#to-flash").disabled = !state.profile
    || (Boolean(state.device?.ambiguous_with) && !$("#model-confirm").checked)
    || (deskosClean && !$("#deskos-clean-checkbox").checked);
}

function selectInstallMode(value) {
  state.install = value;
  if (value !== "recovery") $("#deskos-clean-checkbox").checked = false;
  updateContinueState();
}

function currentArtifact() {
  return state.profile?.[state.install] || state.profile?.update;
}

function renderFlashSummary() {
  const artifact = currentArtifact();
  const releaseTag = state.profile.tag || state.device.tag;
  const releaseCommit = state.profile.commit || state.device.commit;
  const validation = state.profile.validation;
  const address = artifact.address ?? (state.install === "recovery" ? 0 : 0x10000);
  const installLabel = state.device.id === "deskos-d1l" && state.install === "recovery"
    ? "Fresh clean install"
    : state.install === "recovery" ? "Recovery / migration" : "Normal update";
  $("#flash-summary").innerHTML = `
    <div><small>Hardware</small><b>${escapeHtml(state.device.name)}</b></div>
    <div><small>Build</small><b>${escapeHtml(state.profile.name)}</b></div>
    <div><small>Install</small><b>${installLabel}</b></div>
    <div><small>Exact release</small><b>${escapeHtml(releaseTag)}</b></div>
    <div><small>File</small><b>${escapeHtml(artifact.name)}</b></div>
    <div><small>Size</small><b>${(artifact.size / 1024).toFixed(1)} KiB</b></div>
    <div><small>Commit</small><b>${escapeHtml(releaseCommit.slice(0, 12))}</b></div>
    <div><small>Flash address</small><b>0x${Number(address).toString(16)}</b></div>
    <div><small>Verification</small><b>SHA-256${state.device.flash_method === "esp32" ? " + flash MD5" : " + USB return"}</b></div>
    ${validation ? `<div class="validation-evidence"><small>Hardware evidence</small><a href="${escapeHtml(validation.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(validation.label)} ↗</a></div>` : ""}
  `;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchFirmware(artifact, { log = flashLog, showProgress = true } = {}) {
  const candidates = [artifact.local_url, artifact.url].filter(Boolean);
  let lastError;
  for (const url of candidates) {
    try {
      log(`Downloading ${artifact.name}`);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== artifact.size) throw new Error(`size mismatch (${buffer.byteLength}, expected ${artifact.size})`);
      if (showProgress) setProgress("Verifying SHA-256", 4);
      const actual = await sha256(buffer);
      if (actual !== artifact.sha256.toLowerCase()) throw new Error("SHA-256 mismatch");
      log(`SHA-256 verified: ${actual}`);
      return new Uint8Array(buffer);
    } catch (error) {
      lastError = error;
      log(`Download source failed: ${error.message}`);
    }
  }
  throw new Error(`Firmware download failed: ${lastError?.message || "no source"}`);
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function setDeskOsSetupState(id, text, kind = "pending") {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.classList.remove("pending", "working", "ready", "error");
  element.classList.add(kind);
}

function updateDeskOsCompletion({ bridgeReady = false, sdReady = false } = {}) {
  const completeCount = 1 + Number(bridgeReady) + Number(sdReady);
  const complete = completeCount === 3;
  const cleanInstall = state.install === "recovery";
  $("#deskos-install-count").textContent = `${cleanInstall ? "Fresh DeskOS install" : "DeskOS setup"} · ${completeCount} of 3`;
  $("#deskos-install-progress").value = completeCount;
  $("#deskos-install-progress").textContent = `${completeCount} of 3`;
  $("#deskos-install-status").classList.toggle("complete", complete);
  $("#deskos-install-status").classList.toggle("incomplete", !complete);
  $("#deskos-success-mark").classList.toggle("pending", !complete);
  $("#deskos-success-mark").textContent = complete ? "✓" : "!";

  const action = $("#deskos-required-action");
  action.disabled = complete;
  if (complete) {
    $("#deskos-install-title").textContent = "DeskOS installation complete";
    $("#deskos-install-copy").textContent = "The ESP32 firmware, RP2040 bridge, and FAT32 SD storage are verified on the D1L.";
    action.textContent = "Installation complete";
  } else if (!bridgeReady) {
    $("#deskos-install-title").textContent = "ESP32 ready; RP2040 bridge required";
    $("#deskos-install-copy").textContent = state.deskosBridgeSent
      ? "Reconnect the ESP32 USB side, then verify the bridge."
      : "Hold BOOTSEL while reconnecting the RP2040 side, then select its RPI-RP2 drive.";
    action.textContent = state.deskosBridgeSent ? "Verify RP2040 bridge" : "Install RP2040 bridge";
  } else {
    $("#deskos-install-title").textContent = "Bridge ready; FAT32 SD card required";
    $("#deskos-install-copy").textContent = state.deskosSdPrepared
      ? "Insert the prepared card, reconnect the ESP32 side, then verify storage."
      : "Select the FAT32 card in its reader. Existing files will not be replaced.";
    action.textContent = state.deskosSdPrepared ? "Verify SD card in DeskOS" : "Prepare FAT32 SD card";
  }
}

function reflectDeskOsStorage(storage) {
  const bridgeReady = storage?.rp2040_bridge_ready === true
    && storage?.rp2040_protocol_supported !== false;
  const sdReady = bridgeReady && storage?.present === true
    && storage?.mounted === true && storage?.data_root_ready === true;
  setDeskOsSetupState(
    "#deskos-bridge-state",
    bridgeReady ? "Bridge ready" : "Needs verification",
    bridgeReady ? "ready" : "pending",
  );
  let sdText = "Needs setup";
  let sdKind = "pending";
  if (storage?.needs_fat32 === true) {
    sdText = "FAT32 required";
    sdKind = "error";
  } else if (sdReady) {
    sdText = "SD ready";
    sdKind = "ready";
  }
  setDeskOsSetupState("#deskos-sd-state", sdText, sdKind);
  updateDeskOsCompletion({ bridgeReady, sdReady });
  return { bridgeReady, sdReady };
}

async function disconnectDeskOsConsole() {
  if (state.cli) {
    try { await state.cli.disconnect(); } catch (_error) {}
  }
  state.cli = null;
  state.port = null;
}

function bytesToBinaryString(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return chunks.join("");
}

function portMatchesDevice(port, device) {
  const info = port.getInfo();
  if (device.usb_vid && info.usbVendorId && info.usbVendorId !== device.usb_vid) return false;
  if (device.usb_pid && info.usbProductId && info.usbProductId !== device.usb_pid) return false;
  return true;
}

function usbFilters(device) {
  if (device.usb_vid && device.usb_pid) return [{ usbVendorId: device.usb_vid, usbProductId: device.usb_pid }];
  if (device.flash_method === "esp32") return [{ usbVendorId: 0x303a }];
  return [];
}

async function requestMatchingPort(device) {
  const port = await navigator.serial.requestPort({ filters: usbFilters(device) });
  const info = port.getInfo();
  flashLog(`USB selected: VID ${hex(info.usbVendorId)} · PID ${hex(info.usbProductId)}`);
  if (!portMatchesDevice(port, device)) throw new Error("The selected USB device does not match this hardware profile.");
  return port;
}

function hex(value) {
  return value == null ? "unknown" : `0x${value.toString(16).padStart(4, "0")}`;
}

async function flashEsp32(artifact, bytes) {
  if (!artifact.md5) throw new Error("This catalog has no device-verification MD5. The deployment is incomplete; flashing was blocked.");
  const port = await requestMatchingPort(state.device);
  state.port = port;
  let transport;
  try {
    setProgress("Connecting to ROM bootloader", 6);
    transport = new Transport(port, true);
    const terminal = {
      clean: () => {},
      write: (message) => flashLog(message),
      writeLine: (message) => flashLog(message),
    };
    const loader = new ESPLoader({ transport, baudrate: 115200, terminal });
    await loader.main();
    const chip = loader.chip?.CHIP_NAME || "unknown ESP32";
    flashLog(`Detected chip: ${chip}`);
    if (!chip.toUpperCase().includes(state.device.expected_chip.toUpperCase())) {
      throw new Error(`Wrong chip. Selected ${state.device.expected_chip}, detected ${chip}.`);
    }
    const address = artifact.address ?? (state.install === "recovery" ? 0 : 0x10000);
    setProgress("Writing verified firmware", 8);
    await loader.writeFlash({
      fileArray: [{ data: bytesToBinaryString(bytes), address }],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_index, written, total) => setProgress("Writing verified firmware", 8 + (written / total) * 82),
    });
    setProgress("Verifying flash contents", 93);
    const actual = await loader.flashMd5sum(address, bytes.byteLength);
    const actualMd5 = typeof actual === "string" ? actual.toLowerCase() : [...actual].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (actualMd5 !== artifact.md5.toLowerCase()) throw new Error(`Flash MD5 mismatch: device ${actualMd5}, expected ${artifact.md5}`);
    flashLog(`Device flash MD5 verified: ${actualMd5}`);
    setProgress("Resetting device", 98);
    await loader.after("hard_reset");
    await sleep(300);
    await transport.disconnect();
    transport = null;
    setProgress("Flash verified", 100);
  } finally {
    if (transport) {
      try { await transport.disconnect(); } catch (_error) {}
    }
  }
}

async function flashUf2(artifact, bytes) {
  state.port = await requestMatchingPort(state.device);
  setProgress("UF2 image verified", 20);
  flashLog("RC52 identity matched. Double-press Reset now to expose the UF2 drive.");
  if (!window.showDirectoryPicker) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = artifact.name;
    link.click();
    URL.revokeObjectURL(link.href);
    throw new Error("This browser cannot write the UF2 drive directly. The verified UF2 was downloaded; copy it to the RC52 bootloader drive, then continue with the restart check.");
  }
  const directory = await window.showDirectoryPicker({ mode: "readwrite", id: "neonpocket-uf2" });
  try {
    const infoHandle = await directory.getFileHandle("INFO_UF2.TXT");
    const info = await (await infoHandle.getFile()).text();
    flashLog(`UF2 bootloader detected: ${info.split(/\r?\n/)[0] || "INFO_UF2.TXT"}`);
  } catch (_error) {
    throw new Error("The selected folder is not an RC52 UF2 bootloader drive (INFO_UF2.TXT was not found).");
  }
  setProgress("Copying application UF2", 45);
  const firmware = await directory.getFileHandle(artifact.name, { create: true });
  const writable = await firmware.createWritable();
  await writable.write(bytes);
  setProgress("Finalizing UF2", 90);
  await writable.close();
  setProgress("UF2 copied", 100);
  flashLog("UF2 copy completed. The RC52 should reboot automatically.");
}

async function flashSelected() {
  const button = $("#flash-button");
  button.disabled = true;
  resetLog($("#flash-log"), "Starting fail-closed flash workflow…");
  setProgress("Downloading exact release", 1);
  try {
    const artifact = currentArtifact();
    const bytes = await fetchFirmware(artifact);
    if (state.device.flash_method === "esp32") await flashEsp32(artifact, bytes);
    else await flashUf2(artifact, bytes);
    flashLog("Firmware write completed. Keep USB connected.");
    enableThrough(4);
    goToStep(4);
  } catch (error) {
    flashLog(`ERROR: ${error.message}`);
    setProgress("Stopped safely", 0);
  } finally {
    button.disabled = false;
  }
}

async function readBootSample(port, durationMs = 6000) {
  await port.open({ baudRate: 115200 });
  const decoder = new TextDecoder();
  const reader = port.readable.getReader();
  let output = "";
  const deadline = Date.now() + durationMs;
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        sleep(350).then(() => ({ timeout: true })),
      ]);
      if (result.timeout) continue;
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      if (output.length > 24000) output = output.slice(-24000);
    }
  } finally {
    try { await reader.cancel(); } catch (_error) {}
    reader.releaseLock();
    await port.close();
  }
  return output;
}

function parseCliJson(reply, command) {
  try {
    return JSON.parse(reply);
  } catch (_error) {
    throw new Error(`DeskOS returned an unreadable ${command} reply.`);
  }
}

async function verifyDeskOsIdentity(port) {
  resetLog($("#deskos-log"), "Checking the installed DeskOS identity over USB…");
  let cli;
  try {
    cli = await connectConsole(port);
    const version = parseCliJson(await cli.command("version", { timeout: 12000 }), "version");
    const expectedVersion = state.device.tag.replace(/^v/, "");
    if (!version.ok || version.firmware !== "MeshCore DeskOS D1L") throw new Error("The connected device did not identify itself as DeskOS D1L.");
    if (version.version !== expectedVersion) throw new Error(`Wrong DeskOS version: device ${version.version}, expected ${expectedVersion}.`);
    if (version.build_commit !== state.device.commit) throw new Error("DeskOS build commit does not match the selected release.");

    const health = parseCliJson(await cli.command("health", { timeout: 12000 }), "health");
    if (!health.ok || !health.board_ready || !health.ui_ready) throw new Error("DeskOS started, but its board or interface is not ready.");
    const storage = parseCliJson(await cli.command("storage status", { timeout: 12000 }), "storage status");
    if (!storage.ok) throw new Error("DeskOS started, but storage is not ready.");

    state.deskosVerified = { version, health, storage };
    $("#deskos-release").textContent = `v${version.version}`;
    $("#deskos-build").textContent = version.build_commit.slice(0, 12);
    const setup = reflectDeskOsStorage(storage);
    $("#deskos-health").textContent = setup.sdReady ? "Firmware and SD ready" : "Firmware ready; finish setup";
    deskosLog(`PASS: DeskOS ${version.version}`);
    deskosLog(`PASS: exact build ${version.build_commit}`);
    deskosLog(`PASS: board and interface ready`);
    deskosLog(storage.data_enabled ? "PASS: SD storage ready" : "PASS: DeskOS is healthy without SD-backed storage");
  } catch (error) {
    if (cli) {
      try { await cli.disconnect(); } catch (_disconnectError) {}
    }
    state.cli = null;
    throw error;
  }
}

async function verifyBoot() {
  const button = $("#verify-boot");
  button.disabled = true;
  resetLog($("#boot-log"), "Choose the same device after it has restarted…");
  try {
    const port = await navigator.serial.requestPort({ filters: usbFilters(state.device) });
    if (!portMatchesDevice(port, state.device)) throw new Error("The selected USB device is not the flashed hardware.");
    state.port = port;
    bootLog(`USB returned: VID ${hex(port.getInfo().usbVendorId)} · PID ${hex(port.getInfo().usbProductId)}`);
    bootLog("Listening briefly for startup output…");
    const sample = await readBootSample(port);
    if (sample.trim()) bootLog(sample.trim());
    else bootLog("No text startup log was emitted; USB enumeration succeeded.");
    if (/storage error|radio init failed|guru meditation|panic|assert failed/i.test(sample)) {
      throw new Error("Startup output contains a fatal error. Do not disconnect USB.");
    }
    if (state.device.id === "deskos-d1l") {
      bootLog("Verifying the exact DeskOS release and health…");
      await verifyDeskOsIdentity(port);
      bootLog(`PASS: DeskOS ${state.deskosVerified.version.version} matches ${state.device.commit.slice(0, 12)}.`);
    }
    bootLog("PASS: the expected USB device returned without a detected fatal startup marker.");
    prepareOnboarding();
    enableThrough(5);
    goToStep(5);
  } catch (error) {
    bootLog(`ERROR: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function prepareOnboarding() {
  const type = state.profile.onboarding;
  const deskos = type === "deskos";
  const wdgSidecar = type === "wdg-sidecar";
  const companion = type.startsWith("companion");
  $("#companion-onboarding").classList.toggle("hidden", !companion);
  $("#deskos-onboarding").classList.toggle("hidden", !deskos);
  $("#wdg-onboarding").classList.toggle("hidden", !wdgSidecar);
  $("#server-onboarding").classList.toggle("hidden", companion || deskos || wdgSidecar);
  if (wdgSidecar) {
    $("#onboarding-heading").textContent = "Firmware verified. Configure the live-only WDG Mesh Sidecar.";
    return;
  }
  if (deskos) {
    $("#onboarding-heading").textContent = "The exact ESP32 release is verified. Complete the remaining D1L installation stages.";
    reflectDeskOsStorage(state.deskosVerified?.storage);
    requestAnimationFrame(() => $("#deskos-required-action").focus({ preventScroll: true }));
    return;
  }
  if (companion) {
    const usb = type === "companion-usb";
    const web = type === "companion-web";
    const headless = type === "companion-headless";
    const headlessWeb = web && state.device.id === "rcc6-headless-companion";
    $("#companion-instructions").textContent = headlessWeb
      ? "Keep USB connected after restart and open the 115200-baud serial console below. It prints the setup AP name, password and address. Complete Local Wi-Fi Setup in the WebUI; after the device joins your LAN, the console prints its new IP. TCP/5000 is a full companion/admin interface for trusted LANs only."
      : web
        ? "Read the AP name, password and address from the TFT, connect to it, and complete Local Wi-Fi Setup in the WebUI. After it joins your LAN, the TFT shows its new IP. TCP/5000 is a full companion/admin interface for trusted LANs only."
      : usb
        ? "Keep USB connected and open a desktop MeshCore companion that supports the standard serial transport. Select the NeonPocket serial device; this is the binary companion protocol, not the text CLI."
        : headless
          ? "Open a standard MeshCore companion app, select the advertised NeonPocket device, and pair with PIN 123456. This build has no display; radio preset, name and channels are managed through the companion app."
          : "Open a standard MeshCore companion app, select the advertised NeonPocket device, and use the PIN shown on its screen. Radio preset, name and channels are managed through the companion app.";
    $("#companion-check-connect").textContent = usb
      ? " My desktop companion connected to the NeonPocket serial device."
      : web
        ? " I connected to the setup AP or the displayed local-network address."
        : headless
          ? " I paired or connected using PIN 123456."
          : " I paired or connected using the PIN shown by the device.";
    $("#companion-check-sync").textContent = " My identity, contacts and channels loaded correctly.";
    return;
  }
  const network = type.includes("network");
  const room = type.startsWith("room");
  $("#network-fields").classList.toggle("hidden", !network);
  $("#guest-password-field").classList.toggle("hidden", !room);
  $("#wifi-ssid").required = network;
  $("#mqtt-iata").required = network;
  $("#guest-password").required = room;
  $("#onboarding-heading").textContent = network
    ? "The USB wizard applies radio, Wi-Fi, MQTT and security settings, reboots, verifies saved values and reports the LAN IP."
    : "The USB wizard applies and verifies the node, radio, forwarding and security settings before deployment.";
}

class CliSession {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.buffer = "";
    this.waiter = null;
    this.running = false;
  }

  async connect() {
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.running = true;
    this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop();
        lines.forEach((line) => this.onLine(line));
      }
    } catch (error) {
      if (this.running) serialLog(`*** Console disconnected: ${error.message}`);
    }
  }

  onLine(line) {
    serialLog(line);
    if (this.waiter && /^\s*->/.test(line)) {
      const waiter = this.waiter;
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(line.replace(/^\s*->\s*/, "").trim());
    }
  }

  async write(command, display = command) {
    serialLog(`> ${display}`);
    await this.writer.write(new TextEncoder().encode(`${command}\r\n`));
  }

  async command(command, { secret = false, timeout = 7000 } = {}) {
    if (this.waiter) throw new Error("another CLI command is still pending");
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`No CLI reply for ${secret ? "a secret setting" : command}`));
      }, timeout);
      this.waiter = { resolve, reject, timer };
    });
    await this.write(command, secret ? `${command.split(" ").slice(0, 2).join(" ")} [hidden]` : command);
    const reply = await response;
    if (/^(error|err|unknown|\?\?)/i.test(reply)) throw new Error(`${command.split(" ")[0]} failed: ${reply}`);
    return reply;
  }

  async disconnect() {
    this.running = false;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error("console disconnected"));
      this.waiter = null;
    }
    try { await this.reader?.cancel(); } catch (_error) {}
    try { this.reader?.releaseLock(); } catch (_error) {}
    try { this.writer?.releaseLock(); } catch (_error) {}
    try { await this.port.close(); } catch (_error) {}
  }
}

async function connectConsole(port = null) {
  if (state.cli?.running) return state.cli;
  const selected = port || state.port || await navigator.serial.requestPort({ filters: usbFilters(state.device) });
  if (!portMatchesDevice(selected, state.device)) throw new Error("The selected USB device does not match the chosen hardware.");
  resetLog($("#serial-log"), "Opening 115200 baud MeshCore CLI…");
  const cli = new CliSession(selected);
  await cli.connect();
  state.port = selected;
  state.cli = cli;
  $("#apply-config").disabled = false;
  $("#send-command").disabled = false;
  serialLog("*** Console connected");
  return cli;
}

function formConfig() {
  const preset = state.catalog.radio_presets[Number($("#radio-preset").value)];
  const network = state.profile.onboarding.includes("network");
  const room = state.profile.onboarding.startsWith("room");
  const config = {
    name: $("#node-name").value.trim(),
    preset,
    tx: $("#tx-power").value,
    repeat: $("#repeat-mode").value,
    admin: $("#admin-password").value,
    guest: room ? $("#guest-password").value : "",
    network,
    room,
    ssid: network ? $("#wifi-ssid").value : "",
    wifiPassword: network ? $("#wifi-password").value : "",
    iata: network ? $("#mqtt-iata").value.trim().toUpperCase() : "",
    mqtt1: network ? $("#mqtt-one").value : "",
    mqtt2: network ? $("#mqtt-two").value : "",
  };
  if (!config.name || /[\[\]\/\\:,?*]/.test(config.name)) throw new Error("Enter a valid node name without [ ] / \\ : , ? or *.");
  if (network && !config.ssid) throw new Error("Enter the 2.4 GHz Wi-Fi SSID.");
  if (network && !/^[A-Z0-9]{3}$/.test(config.iata)) throw new Error("IATA must be exactly three letters or digits.");
  if (network && config.mqtt1 === config.mqtt2 && config.mqtt1 !== "none") throw new Error("Choose two different MQTT servers, or disable one slot.");
  return config;
}

function configurationCommands(config) {
  const radio = `${config.preset.freq},${config.preset.bw},${config.preset.sf},${config.preset.cr}`;
  const commands = [
    [`set name ${config.name}`],
    [`set radio ${radio}`],
    [`set tx ${config.tx}`],
    ["set radio.rxgain on"],
    [`set repeat ${config.repeat}`],
    ["set path.hash.mode 2"],
  ];
  if (config.network) {
    commands.push(
      [`set mqtt.origin ${config.name}`],
      [`set mqtt.iata ${config.iata}`],
      ["set mqtt1.preset none"],
      ["set mqtt2.preset none"],
      [`set mqtt1.preset ${config.mqtt1}`],
      [`set mqtt2.preset ${config.mqtt2}`],
      ["set mqtt.rx on"],
      ["set mqtt.tx advert"],
      [`set wifi.ssid ${config.ssid}`],
    );
    if (config.wifiPassword) commands.push([`set wifi.pwd ${config.wifiPassword}`, { secret: true }]);
  }
  commands.push([`password ${config.admin}`, { secret: true }]);
  if (config.room) commands.push([`set guest.password ${config.guest}`, { secret: true }]);
  return commands;
}

async function verifyConfiguration(cli, config) {
  const expected = {
    name: config.name,
    radio: `${config.preset.freq},${config.preset.bw},${config.preset.sf},${config.preset.cr}`,
    tx: String(config.tx),
    repeat: config.repeat,
    "path.hash.mode": "2",
  };
  if (config.network) Object.assign(expected, {
    "wifi.ssid": config.ssid,
    "mqtt.iata": config.iata,
    "mqtt1.preset": config.mqtt1,
    "mqtt2.preset": config.mqtt2,
    "mqtt.rx": "on",
    "mqtt.tx": "advert",
  });
  for (const [key, wanted] of Object.entries(expected)) {
    const actual = await cli.command(`get ${key}`);
    const normalized = (value) => value.toLowerCase().replace(/\s+/g, "");
    if (!normalized(actual).includes(normalized(wanted))) throw new Error(`Verification failed for ${key}: device replied '${actual}'.`);
  }
}

async function reconnectCli(port, timeout = 35000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const cli = new CliSession(port);
      await cli.connect();
      state.cli = cli;
      serialLog("*** Device returned after reboot");
      return cli;
    } catch (_error) {
      await sleep(1000);
    }
  }
  throw new Error("The device did not return after reboot. Keep USB connected and press Reset once.");
}

async function applyConfiguration(event) {
  event.preventDefault();
  const button = $("#apply-config");
  button.disabled = true;
  try {
    const config = formConfig();
    const cli = await connectConsole();
    serialLog("*** Applying settings. Secrets are redacted.");
    for (const [command, options] of configurationCommands(config)) await cli.command(command, options);
    await verifyConfiguration(cli, config);
    serialLog("*** Saved values verified; rebooting.");
    await cli.write("reboot");
    await sleep(300);
    await cli.disconnect();
    state.cli = null;
    const returned = await reconnectCli(state.port);
    await verifyConfiguration(returned, config);
    let ip = "";
    if (config.network) {
      const deadline = Date.now() + 50000;
      while (Date.now() < deadline) {
        const status = await returned.command("get wifi.status");
        const match = status.match(/\bIP:\s*([0-9]+(?:\.[0-9]+){3})/i);
        if (match) { ip = match[1]; break; }
        await sleep(2000);
      }
      if (!ip) throw new Error("Settings were saved, but Wi-Fi did not report an IP within 50 seconds. Keep USB connected and check the SSID/password.");
      serialLog(`*** LAN dashboard: http://${ip}/`);
    }
    $("#completion").classList.remove("hidden");
    $("#completion span").textContent = ip
      ? `Verified after reboot. LAN address: http://${ip}/ — record it before disconnecting USB.`
      : "Verified after reboot. You can now disconnect USB and deploy this NeonPocket.";
    $("#admin-password").value = "";
    $("#guest-password").value = "";
    $("#wifi-password").value = "";
  } catch (error) {
    serialLog(`ERROR: ${error.message}`);
  } finally {
    button.disabled = !state.cli?.running;
  }
}

async function sendManualCommand() {
  const input = $("#serial-command");
  const command = input.value.trim();
  if (!command) return;
  input.value = "";
  try {
    const cli = await connectConsole();
    await cli.command(command);
  } catch (error) {
    serialLog(`ERROR: ${error.message}`);
  }
}

async function installDeskOsBridge() {
  const button = $("#deskos-bridge-button");
  const artifact = state.profile?.bridge;
  if (!artifact) return;
  button.disabled = true;
  resetLog($("#deskos-log"), "Preparing the verified RP2040 SD bridge…");
  setDeskOsSetupState("#deskos-bridge-state", "Waiting for drive", "working");
  try {
    if (!window.showDirectoryPicker) {
      const bytes = await fetchFirmware(artifact, { log: deskosLog, showProgress: false });
      downloadBytes(bytes, artifact.name);
      deskosLog("The verified UF2 was downloaded. Copy it to the RP2040 BOOTSEL drive manually.");
      state.deskosBridgeSent = true;
      setDeskOsSetupState("#deskos-bridge-state", "Manual copy needed", "working");
      updateDeskOsCompletion();
      return;
    }

    // Browser pickers must be opened directly from this click, before network work.
    const directory = await window.showDirectoryPicker({ mode: "readwrite", id: "deskos-rp2040-uf2" });
    await disconnectDeskOsConsole();
    let info;
    try {
      const infoHandle = await directory.getFileHandle("INFO_UF2.TXT");
      info = await (await infoHandle.getFile()).text();
    } catch (_error) {
      throw new Error("That folder is not an RP2040 BOOTSEL drive; INFO_UF2.TXT was not found.");
    }
    if (!/RP2040|RPI-RP2|UF2/i.test(info)) {
      throw new Error("The selected UF2 drive did not identify as an RP2040.");
    }
    deskosLog(`RP2040 bootloader found: ${info.split(/\r?\n/)[0] || "INFO_UF2.TXT"}`);
    const bytes = await fetchFirmware(artifact, { log: deskosLog, showProgress: false });
    const firmware = await directory.getFileHandle(artifact.name, { create: true });
    const writable = await firmware.createWritable();
    await writable.write(bytes);
    await writable.close();
    deskosLog("PASS: verified RP2040 bridge UF2 sent. The bridge should restart automatically.");
    deskosLog("Reconnect the ESP32 USB side, then choose Verify bridge.");
    deskosLog("The SD card was not formatted or written by this site.");
    state.deskosBridgeSent = true;
    setDeskOsSetupState("#deskos-bridge-state", "UF2 sent; verify", "working");
    updateDeskOsCompletion();
  } catch (error) {
    if (error.name === "AbortError") {
      deskosLog("Bridge install cancelled; nothing was changed.");
      setDeskOsSetupState("#deskos-bridge-state", "Not checked", "pending");
    } else {
      deskosLog(`ERROR: ${error.message}`);
      setDeskOsSetupState("#deskos-bridge-state", "Install stopped", "error");
    }
  } finally {
    button.disabled = false;
  }
}

async function fetchDeskOsSdBundle() {
  if (state.deskosSdBundle) return state.deskosSdBundle;
  const response = await fetch("/assets/deskos-sd/bundle.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`SD setup package returned HTTP ${response.status}.`);
  const bundle = await response.json();
  const safePath = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
  if (bundle.schema !== 1 || bundle.device !== "deskos-d1l"
      || !Array.isArray(bundle.directories) || !Array.isArray(bundle.files)
      || bundle.directories.length > 32 || bundle.files.length > 16) {
    throw new Error("The SD setup package is malformed.");
  }
  for (const path of bundle.directories) {
    if (!safePath.test(path) || !path.startsWith("deskos/")) {
      throw new Error("The SD setup package contains an unsafe directory.");
    }
  }
  for (const file of bundle.files) {
    if (!safePath.test(file.target) || !file.target.startsWith("deskos/")
        || !String(file.url).startsWith("/assets/deskos-sd/")
        || !/^[0-9a-f]{64}$/.test(file.sha256)
        || !Number.isInteger(file.size) || file.size < 1 || file.size > 65536) {
      throw new Error("The SD setup package contains an unsafe file.");
    }
  }
  state.deskosSdBundle = bundle;
  return bundle;
}

async function fetchDeskOsSdFile(file) {
  const response = await fetch(file.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${file.target} returned HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== file.size || await sha256(bytes) !== file.sha256) {
    throw new Error(`${file.target} failed its size or SHA-256 check.`);
  }
  return bytes;
}

async function directoryForPath(root, parts, create = false) {
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

async function existingFileHandle(directory, name) {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

async function writeDeskOsSdFile(root, file, bytes) {
  const parts = file.target.split("/");
  const name = parts.pop();
  const directory = await directoryForPath(root, parts, true);
  let handle = await existingFileHandle(directory, name);
  if (handle) {
    const existing = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (existing.byteLength !== bytes.byteLength || await sha256(existing) !== file.sha256) {
      throw new Error(`Refusing to replace a different existing file: ${file.target}`);
    }
    return "already correct";
  }

  let created = false;
  try {
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    const written = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if (written.byteLength !== bytes.byteLength || await sha256(written) !== file.sha256) {
      throw new Error(`Read-back verification failed: ${file.target}`);
    }
    return "written and verified";
  } catch (error) {
    if (created) {
      try { await directory.removeEntry(name); } catch (_cleanupError) {}
    }
    throw error;
  }
}

async function prepareDeskOsSdCard() {
  const button = $("#deskos-sd-button");
  button.disabled = true;
  resetLog($("#deskos-log"), "Preparing a DeskOS SD card without formatting or deleting…");
  setDeskOsSetupState("#deskos-sd-state", "Waiting for card", "working");
  try {
    if (!window.showDirectoryPicker) {
      throw new Error("SD setup requires Chrome or Edge with directory access. The release package still includes the desktop SD setup scripts.");
    }
    // Keep this picker before downloads so the browser sees the button gesture.
    const root = await window.showDirectoryPicker({ mode: "readwrite", id: "deskos-sd-card" });
    try {
      await root.getFileHandle("INFO_UF2.TXT");
      throw new Error("That is the RP2040 bootloader drive, not the microSD card.");
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }

    const bundle = await fetchDeskOsSdBundle();
    deskosLog(`SD setup package revision ${bundle.payload_revision} accepted.`);
    for (const path of bundle.directories) {
      await directoryForPath(root, path.split("/"), true);
    }
    for (const file of bundle.files) {
      const bytes = await fetchDeskOsSdFile(file);
      const result = await writeDeskOsSdFile(root, file, bytes);
      deskosLog(`PASS: ${file.target} — ${result}`);
    }
    deskosLog("PASS: DeskOS folders and files read back correctly. No existing file was replaced.");
    deskosLog("Insert the card into the D1L, reconnect the ESP32 side, then choose Verify in DeskOS.");
    state.deskosSdPrepared = true;
    setDeskOsSetupState("#deskos-sd-state", "Prepared; verify", "working");
    updateDeskOsCompletion({ bridgeReady: true });
  } catch (error) {
    if (error.name === "AbortError") {
      deskosLog("SD setup cancelled; nothing was changed.");
      setDeskOsSetupState("#deskos-sd-state", "Not checked", "pending");
    } else {
      deskosLog(`ERROR: ${error.message}`);
      setDeskOsSetupState("#deskos-sd-state", "Setup stopped", "error");
    }
  } finally {
    button.disabled = false;
  }
}

async function verifyDeskOsStorage(kind) {
  const button = kind === "bridge" ? $("#deskos-bridge-verify") : $("#deskos-sd-verify");
  button.disabled = true;
  setDeskOsSetupState(
    kind === "bridge" ? "#deskos-bridge-state" : "#deskos-sd-state",
    "Checking DeskOS",
    "working",
  );
  try {
    const selected = await navigator.serial.requestPort({ filters: usbFilters(state.device) });
    if (!portMatchesDevice(selected, state.device)) {
      throw new Error("The selected USB device is not the DeskOS ESP32 side.");
    }
    await disconnectDeskOsConsole();
    const cli = await connectConsole(selected);
    let storage = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      storage = parseCliJson(
        await cli.command("storage status", { timeout: 12000 }),
        "storage status",
      );
      const result = reflectDeskOsStorage(storage);
      if (result.bridgeReady && (kind === "bridge" || result.sdReady)) break;
      await sleep(1500);
    }
    const result = reflectDeskOsStorage(storage);
    state.deskosVerified = { ...(state.deskosVerified || {}), storage };
    if (!result.bridgeReady) {
      throw new Error("DeskOS cannot reach the RP2040 bridge yet. Recheck BOOTSEL flashing and the ESP32 cable.");
    }
    deskosLog("PASS: DeskOS reports the RP2040 bridge protocol ready.");
    if (kind === "sd") {
      if (!result.sdReady) {
        throw new Error(storage?.needs_fat32
          ? "DeskOS found the card, but it is not FAT32. Format it on a computer, then prepare it again."
          : "DeskOS has not mounted the prepared card yet. Reseat it, wait a few seconds, and retry.");
      }
      deskosLog("PASS: DeskOS reports the SD card mounted with its data root ready.");
    }
    $("#deskos-health").textContent = result.sdReady ? "Firmware and SD ready" : "Firmware and bridge ready";
  } catch (error) {
    if (error.name === "NotFoundError" || error.name === "AbortError") {
      deskosLog("DeskOS verification cancelled; nothing was changed.");
      reflectDeskOsStorage(state.deskosVerified?.storage);
    } else {
      deskosLog(`ERROR: ${error.message}`);
      setDeskOsSetupState(
        kind === "bridge" ? "#deskos-bridge-state" : "#deskos-sd-state",
        "Check failed",
        "error",
      );
    }
  } finally {
    button.disabled = false;
  }
}

async function runRequiredDeskOsAction() {
  const storage = state.deskosVerified?.storage;
  const bridgeReady = storage?.rp2040_bridge_ready === true
    && storage?.rp2040_protocol_supported !== false;
  const sdReady = bridgeReady && storage?.present === true
    && storage?.mounted === true && storage?.data_root_ready === true;
  if (!bridgeReady) {
    if (state.deskosBridgeSent) await verifyDeskOsStorage("bridge");
    else await installDeskOsBridge();
  } else if (!sdReady) {
    if (state.deskosSdPrepared) await verifyDeskOsStorage("sd");
    else await prepareDeskOsSdCard();
  }
}

function populateOptions() {
  $("#radio-preset").innerHTML = state.catalog.radio_presets.map((preset, index) => `<option value="${index}">${escapeHtml(preset.name)} — ${preset.freq} MHz / BW ${preset.bw} / SF${preset.sf} / CR${preset.cr}</option>`).join("");
  const brokerOptions = state.catalog.mqtt_presets.map((preset) => `<option value="${escapeHtml(preset)}">${escapeHtml(preset)}</option>`).join("");
  $("#mqtt-one").innerHTML = brokerOptions;
  $("#mqtt-two").innerHTML = brokerOptions;
  $("#mqtt-one").value = "meshcore-ca-1";
  $("#mqtt-two").value = "meshcore-ca-2";
}

function bindEvents() {
  $$('[data-go]').forEach((button) => button.addEventListener("click", () => goToStep(Number(button.dataset.go))));
  $$('input[name="install"]').forEach((radio) => radio.addEventListener("change", () => selectInstallMode(radio.value)));
  $("#model-confirm").addEventListener("change", updateContinueState);
  $("#deskos-clean-checkbox").addEventListener("change", updateContinueState);
  $("#to-flash").addEventListener("click", () => {
    state.install = $('input[name="install"]:checked')?.value || "update";
    renderFlashSummary();
    enableThrough(3);
    goToStep(3);
  });
  $("#flash-button").addEventListener("click", flashSelected);
  $("#verify-boot").addEventListener("click", verifyBoot);
  $("#connect-console").addEventListener("click", async () => {
    try { await connectConsole(); } catch (error) { serialLog(`ERROR: ${error.message}`); }
  });
  $("#server-onboarding").addEventListener("submit", applyConfiguration);
  $("#send-command").addEventListener("click", sendManualCommand);
  $("#deskos-bridge-button").addEventListener("click", installDeskOsBridge);
  $("#deskos-bridge-verify").addEventListener("click", () => verifyDeskOsStorage("bridge"));
  $("#deskos-sd-button").addEventListener("click", prepareDeskOsSdCard);
  $("#deskos-sd-verify").addEventListener("click", () => verifyDeskOsStorage("sd"));
  $("#deskos-required-action").addEventListener("click", runRequiredDeskOsAction);
  $("#serial-command").addEventListener("keydown", (event) => { if (event.key === "Enter") sendManualCommand(); });
}

async function init() {
  state.stepperTop = $(".stepper").offsetTop;
  bindEvents();
  const issues = [];
  if (!window.isSecureContext && location.hostname !== "localhost") issues.push("Web Serial requires HTTPS.");
  if (!navigator.serial) issues.push("Use current desktop Chrome or Edge; this browser has no Web Serial support.");
  if (!window.showDirectoryPicker) issues.push("Direct UF2 and SD setup require desktop Chrome or Edge directory access.");
  if (issues.length) {
    $("#compatibility").textContent = issues.join(" ");
    $("#compatibility").classList.remove("hidden");
  }
  try {
    const response = await fetch("/catalog.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.catalog = await response.json();
    $("#suite-version").textContent = `Suite ${state.catalog.suite_version}`;
    renderDevices();
    populateOptions();
  } catch (error) {
    $("#compatibility").textContent = `Firmware catalog failed to load: ${error.message}`;
    $("#compatibility").classList.remove("hidden");
  }
}

init();
