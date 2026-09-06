import { ESPLoader, Transport } from "/lib/esp32.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  catalog: null,
  deviceFamily: null,
  device: null,
  profile: null,
  install: "update",
  flashing: false,
  maxStep: 1,
  port: null,
  cli: null,
  deskosVerified: null,
  deskosSdBundle: null,
  deskosBridgeSent: false,
  deskosSdPrepared: false,
  stepperTop: null,
  meshGangsToken: null,
  meshGangsTokenError: false,
  meshGangsRole: "mobile",
  meshGangsEnrollment: null,
  meshGangsProvisioned: false,
  meshGangsUsbKey: null,
  modemAudio: false,
};

const deviceFamilies = [
  {
    id: "radiocore",
    name: "RadioCore",
    summary: "RCC6 and RC52 companions, services and repeaters.",
    deviceIds: ["rc52-companion", "rc52-headless-companion", "rc52-server", "rcc6-companion", "rcc6-headless-companion", "rcc6-server"],
  },
  {
    id: "heltec-oled",
    name: "Heltec OLED",
    summary: "WiFi LoRa 32 V3 and V4 / V4.3 builds.",
    deviceIds: ["heltec-v3", "heltec-v4"],
  },
  {
    id: "solar-maker",
    name: "Solar + Maker",
    summary: "RAK and XIAO ultra-low-power solar repeaters.",
    deviceIds: ["rak4631-ulp", "rak3401-1w-ulp", "xiao-esp32s3-ulp", "xiao-nrf52840-ulp"],
  },
  {
    id: "deskos",
    name: "DeskOS",
    summary: "SenseCAP Indicator D1L desktop console.",
    deviceIds: ["deskos-d1l"],
  },
];

const meshGangsRoles = new Set(["usb", "wifi", "mobile"]);
const meshGangsHandoffKey = "neonpocket.meshgangs.handoff.v1";

const flashLog = (text) => appendLog($("#flash-log"), text);
const bootLog = (text) => appendLog($("#boot-log"), text);
const serialLog = (text) => appendLog($("#serial-log"), text);
const deskosLog = (text) => appendLog($("#deskos-log"), text);

function playModem(mode = "hop") {
  if (!state.modemAudio) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  const audio = new Audio();
  const master = audio.createGain();
  master.gain.setValueAtTime(mode === "dial" ? .032 : .022, audio.currentTime);
  master.connect(audio.destination);
  const tones = mode === "dial"
    ? [[620, 980, .14], [1180, 1180, .08], [760, 1920, .16], [2200, 1050, .14], [980, 2380, .15], [1880, 720, .16], [1300, 2200, .14]]
    : [[780, 1180, .045], [1450, 920, .045]];
  let cursor = audio.currentTime;
  tones.forEach(([start, end, duration], index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = index % 3 === 0 ? "square" : "sine";
    oscillator.frequency.setValueAtTime(start, cursor);
    oscillator.frequency.exponentialRampToValueAtTime(end, cursor + duration);
    gain.gain.setValueAtTime(0, cursor);
    gain.gain.linearRampToValueAtTime(1, cursor + .01);
    gain.gain.linearRampToValueAtTime(0, cursor + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(cursor);
    oscillator.stop(cursor + duration);
    cursor += duration + .02;
  });
  setTimeout(() => audio.close(), mode === "dial" ? 1700 : 300);
}

function toggleModemAudio() {
  state.modemAudio = !state.modemAudio;
  const toggle = $("#modem-audio-toggle");
  toggle.setAttribute("aria-pressed", String(state.modemAudio));
  toggle.textContent = `56K AUDIO: ${state.modemAudio ? "ON" : "OFF"}`;
  if (state.modemAudio) playModem("dial");
}

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
  if (state.flashing) return;
  if (step > state.maxStep) return;
  playModem("hop");
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

function captureMeshGangsEnrollment() {
  const requestedRole = new URLSearchParams(location.search).get("role");
  if (meshGangsRoles.has(requestedRole)) state.meshGangsRole = requestedRole;
  if (!location.hash.startsWith("#meshgangs-enroll=")) return;
  const match = location.hash.match(/^#meshgangs-enroll=([A-Za-z0-9_-]{40,64})$/);
  let handoff = null;
  try {
    handoff = JSON.parse(sessionStorage.getItem(meshGangsHandoffKey) || "null");
  } catch (_error) {
    handoff = null;
  }
  try { sessionStorage.removeItem(meshGangsHandoffKey); } catch (_error) {}
  state.meshGangsToken = match?.[1] || null;
  state.meshGangsTokenError = !match;
  state.meshGangsRole = match && meshGangsRoles.has(handoff?.role)
    ? handoff.role
    : (match && meshGangsRoles.has(requestedRole) ? requestedRole : null);
  if (match && typeof handoff?.label === "string"
      && handoff.label.length >= 1 && handoff.label.length <= 60
      && !/[\x00-\x1f\x7f]/.test(handoff.label)) {
    $("#meshgangs-label").value = handoff.label;
  }
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

function saveMeshGangsHandoff() {
  const label = $("#meshgangs-label").value.trim();
  const handoff = {
    role: meshGangsRoles.has(state.meshGangsRole) ? state.meshGangsRole : null,
    label: label.length >= 1 && label.length <= 60 && !/[\x00-\x1f\x7f]/.test(label)
      ? label
      : "MeshGangs collector",
  };
  try { sessionStorage.setItem(meshGangsHandoffKey, JSON.stringify(handoff)); } catch (_error) {}
}

function isMeshGangsSidecar() {
  return state.profile?.onboarding === "meshgangs-sidecar";
}

function meshGangsAllowedRoles() {
  return state.profile?.roles || [...meshGangsRoles];
}

function meshGangsInputsValid() {
  if (!meshGangsAllowedRoles().includes(state.meshGangsRole)) return false;
  const label = $("#meshgangs-label").value.trim();
  if (!label || label.length > 60 || /[\x00-\x1f\x7f]/.test(label)) return false;
  if (state.meshGangsRole !== "wifi") return true;
  const ssid = $("#meshgangs-wifi-ssid").value;
  const password = $("#meshgangs-wifi-password").value;
  const ssidBytes = new TextEncoder().encode(ssid).length;
  const passwordBytes = new TextEncoder().encode(password).length;
  return ssidBytes >= 1 && ssidBytes <= 32
    && passwordBytes <= 63
    && (passwordBytes === 0 || passwordBytes >= 8);
}

function updateMeshGangsSetup() {
  const selected = isMeshGangsSidecar();
  $("#meshgangs-setup").classList.toggle("hidden", !selected);
  if (!selected) return;
  const allowedRoles = meshGangsAllowedRoles();
  if (state.meshGangsRole && !allowedRoles.includes(state.meshGangsRole)) state.meshGangsRole = null;
  const hasEnrollment = Boolean(state.meshGangsToken || state.meshGangsEnrollment);
  const status = $("#meshgangs-account-state");
  status.classList.remove("ready", "error", "working", "pending");
  if (state.meshGangsTokenError) {
    status.textContent = "Account link invalid";
    status.classList.add("error");
  } else if (state.meshGangsEnrollment) {
    status.textContent = "Key created";
    status.classList.add("ready");
  } else if (state.meshGangsToken) {
    status.textContent = state.meshGangsRole ? "Account linked" : "Account linked · choose role";
    status.classList.add("ready");
  } else {
    status.textContent = "Account link required";
    status.classList.add("pending");
  }
  $("#meshgangs-enroll-link").classList.toggle("hidden", hasEnrollment);
  $("#meshgangs-enroll-link").href = `https://mg.canadaverse.org/devices/flasher/?board=${encodeURIComponent(state.device.id)}${state.meshGangsRole ? `&role=${state.meshGangsRole}` : ""}`;
  $("#meshgangs-wifi-fields").classList.toggle("hidden", state.meshGangsRole !== "wifi");
  $$('input[name="meshgangs-role"]').forEach((radio) => {
    radio.checked = radio.value === state.meshGangsRole;
    radio.disabled = Boolean(state.meshGangsEnrollment) || !allowedRoles.includes(radio.value);
    radio.closest(".choice")?.classList.toggle("hidden", !allowedRoles.includes(radio.value));
    radio.closest(".choice")?.classList.toggle("selected", radio.checked);
  });
  ["#meshgangs-label", "#meshgangs-wifi-ssid", "#meshgangs-wifi-password"].forEach((selector) => {
    $(selector).disabled = Boolean(state.meshGangsEnrollment);
  });
}

function resetMeshGangsDeviceWorkflow() {
  const heldDeviceState = Boolean(
    state.meshGangsEnrollment
    || state.meshGangsProvisioned
    || state.meshGangsUsbKey,
  );
  state.meshGangsEnrollment = null;
  state.meshGangsProvisioned = false;
  state.meshGangsUsbKey = null;
  if (heldDeviceState) {
    $("#meshgangs-wifi-ssid").value = "";
    $("#meshgangs-wifi-password").value = "";
  }
}

function renderDevices() {
  const grid = $("#device-grid");
  const family = deviceFamilies.find((candidate) => candidate.id === state.deviceFamily);
  $("#device-family-bar").classList.toggle("hidden", !family);
  grid.classList.toggle("family-grid", !family);

  if (!family) {
    grid.innerHTML = deviceFamilies.map((candidate) => {
      const devices = state.catalog.devices.filter((device) => candidate.deviceIds.includes(device.id));
      const builds = devices.reduce((total, device) => total + device.profiles.length, 0);
      return `
        <button class="device-card family-card" data-device-family="${escapeHtml(candidate.id)}">
          <span class="card-kicker">HARDWARE FAMILY</span>
          <h3>${escapeHtml(candidate.name)}</h3>
          <p>${escapeHtml(candidate.summary)}</p>
          <div class="tags"><span class="tag">${devices.length} device${devices.length === 1 ? "" : "s"}</span><span class="tag">${builds} build${builds === 1 ? "" : "s"}</span></div>
        </button>
      `;
    }).join("");
    $$("[data-device-family]").forEach((card) => card.addEventListener("click", () => {
      state.deviceFamily = card.dataset.deviceFamily;
      renderDevices();
    }));
    return;
  }

  $("#device-family-name").textContent = family.name;
  const devices = state.catalog.devices.filter((device) => family.deviceIds.includes(device.id));
  grid.innerHTML = devices.map((device) => `
    <button class="device-card" data-device="${escapeHtml(device.id)}">
      <span class="device-art" aria-hidden="true"><img src="/assets/devices/${escapeHtml(device.id)}.svg" alt="" width="480" height="480" loading="lazy"></span>
      <span class="card-kicker">${escapeHtml(device.family)}</span>
      <h3>${escapeHtml(device.name)}</h3>
      <p>${escapeHtml(device.display)}</p>
      <div class="tags"><span class="tag">${device.profiles.length} build${device.profiles.length === 1 ? "" : "s"}</span><span class="tag">${device.flash_method === "esp32" ? "Web Serial" : "UF2"}</span></div>
    </button>
  `).join("");
  $$("[data-device]").forEach((card) => card.addEventListener("click", () => selectDevice(card.dataset.device)));
}

function showDeviceFamilies() {
  if (state.flashing) return;
  resetMeshGangsDeviceWorkflow();
  state.deviceFamily = null;
  state.device = null;
  state.profile = null;
  state.install = "update";
  state.maxStep = 1;
  $$(".step").forEach((button, index) => {
    button.disabled = index > 0;
    button.classList.remove("done");
  });
  $("#selected-device-copy").textContent = "";
  renderDevices();
  goToStep(1);
}

function selectDevice(id) {
  if (state.flashing) return;
  resetMeshGangsDeviceWorkflow();
  state.maxStep = 1;
  state.port = null;
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
  $("#release-downloads").innerHTML = (state.device.downloads || []).map((download) =>
    `<a href="${escapeHtml(download.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(download.name)} ↗</a>`
  ).join("");
  $("#install-mode").classList.add("hidden");
  $("#deskos-clean-confirm").classList.add("hidden");
  $("#ambiguous-confirm").classList.add("hidden");
  $("#meshgangs-setup").classList.add("hidden");
  $("#to-flash").disabled = true;
}

function selectProfile(id) {
  if (state.flashing) return;
  resetMeshGangsDeviceWorkflow();
  state.maxStep = 2;
  state.deskosVerified = null;
  enableThrough(2);
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
  updateMeshGangsSetup();
  updateContinueState();
}

function updateContinueState() {
  const deskosClean = state.device?.id === "deskos-d1l" && state.install === "recovery";
  $("#deskos-clean-confirm").classList.toggle("hidden", !deskosClean);
  $("#to-flash").disabled = !state.profile
    || (Boolean(state.device?.ambiguous_with) && !$("#model-confirm").checked)
    || (deskosClean && !$("#deskos-clean-checkbox").checked)
    || (isMeshGangsSidecar() && !(state.meshGangsToken || state.meshGangsEnrollment))
    || (isMeshGangsSidecar() && !meshGangsInputsValid());
}

function selectInstallMode(value) {
  if (state.flashing) return;
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
  const isHeltecV3 = state.device.id === "heltec-v3";
  $("#usb-guidance").textContent = isHeltecV3
    ? "Attach the LoRa antenna. On macOS use current desktop Chrome or Edge. If no port appears, install the CP210x driver, reconnect the V3, and close other serial apps."
    : "Attach the LoRa antenna. Use a data-capable USB cable. Close serial monitors and companion apps.";
  $("#v3-driver-link").classList.toggle("hidden", !isHeltecV3);
  $("#flash-button").disabled = !navigator.serial;
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

function deskOsFirmwareVerified() {
  const verified = state.deskosVerified;
  const expected = state.device?.commit;
  return Boolean(expected) && verified?.version?.ok === true && verified?.health?.ok === true
    && verified?.version?.build_commit === expected && verified?.health?.build_commit === expected
    && verified?.health?.board_ready === true && verified?.health?.ui_ready === true
    && verified?.mesh?.build_commit === expected && verified?.mesh?.radio_ready === true
    && verified?.mesh?.identity_ready === true;
}

function deskOsStorageReadiness(storage) {
  const sd = storage?.sd;
  const current = storage?.ok === true && sd?.status_stale !== true
    && sd?.response_truncated !== true;
  const bridgeReady = current && sd?.rp2040_bridge_ready === true
    && sd?.rp2040_protocol_supported === true;
  const retainedIssue = storage?.retained_sd?.degraded === true
    || storage?.retained_sd?.backup_degraded === true;
  const sdReady = bridgeReady && sd?.presence_stale !== true
    && sd?.present === true && sd?.mounted === true && sd?.data_root_ready === true
    && sd?.file_ops === true && sd?.filesystem === "fat32" && storage?.data_enabled === true
    && storage?.retained_sd?.degraded === false && storage?.retained_sd?.backup_degraded === false;
  return { bridgeReady, sdReady, retainedIssue, needsFat32: sd?.needs_fat32 === true };
}

function updateDeskOsCompletion({ bridgeReady = false, sdReady = false, retainedIssue = false } = {}) {
  const firmwareReady = deskOsFirmwareVerified();
  const completeCount = Number(firmwareReady) + Number(bridgeReady) + Number(sdReady);
  const cleanInstall = state.install === "recovery";
  const complete = cleanInstall ? completeCount === 3 : firmwareReady;
  const progress = cleanInstall ? `${completeCount} of 3` : firmwareReady ? "Update verified" : "Verification required";
  $("#deskos-install-count").textContent = `${cleanInstall ? "Fresh DeskOS install" : "DeskOS update"} · ${progress}`;
  $("#deskos-install-progress").max = cleanInstall ? 3 : 1;
  $("#deskos-install-progress").value = cleanInstall ? completeCount : Number(firmwareReady);
  $("#deskos-install-progress").textContent = progress;
  $("#deskos-install-status").classList.toggle("complete", complete);
  $("#deskos-install-status").classList.toggle("incomplete", !complete);
  $("#deskos-success-mark").classList.toggle("pending", !complete);
  $("#deskos-success-mark").textContent = complete ? "✓" : "!";

  const action = $("#deskos-required-action");
  action.disabled = complete && sdReady;
  if (!firmwareReady) {
    $("#deskos-install-title").textContent = "Verify the installed DeskOS firmware";
    $("#deskos-install-copy").textContent = "Connect the ESP32 USB side and verify the release before finishing setup.";
    action.textContent = "Verify ESP32 firmware";
  } else if (retainedIssue) {
    $("#deskos-install-title").textContent = "Firmware ready; storage needs attention";
    $("#deskos-install-copy").textContent = "DeskOS reported a problem saving history. Keep the card inserted, check Storage on the D1L, and verify again after it recovers.";
    action.textContent = "Recheck storage";
  } else if (complete && !sdReady) {
    $("#deskos-install-title").textContent = "DeskOS update complete";
    $("#deskos-install-copy").textContent = "Firmware is verified. Chat can run live-only; add SD storage for retained history and cached maps.";
    action.textContent = "Set up SD storage (optional)";
  } else if (complete) {
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
  const { bridgeReady, sdReady, needsFat32, retainedIssue } = deskOsStorageReadiness(storage);
  setDeskOsSetupState(
    "#deskos-bridge-state",
    bridgeReady ? "Bridge ready" : "Needs verification",
    bridgeReady ? "ready" : "pending",
  );
  let sdText = "Needs setup";
  let sdKind = "pending";
  if (needsFat32) {
    sdText = "FAT32 required";
    sdKind = "error";
  } else if (retainedIssue) {
    sdText = "History needs attention";
    sdKind = "error";
  } else if (sdReady) {
    sdText = "SD ready";
    sdKind = "ready";
  }
  setDeskOsSetupState("#deskos-sd-state", sdText, sdKind);
  updateDeskOsCompletion({ bridgeReady, sdReady, retainedIssue });
  return { bridgeReady, sdReady, needsFat32, retainedIssue };
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
  if (device.id === "deskos-d1l") {
    return info.usbVendorId === device.usb_vid && info.usbProductId === device.usb_pid;
  }
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

async function verifyMeshGangsFlashHardware(loader, port, artifact, size) {
  if (state.device.id !== "heltec-v4") return;
  const usb = port.getInfo();
  if (usb.usbVendorId !== 0x303a || usb.usbProductId !== 0x1001
      || await loader.chip.getPsramCap(loader) !== 2
      || await loader.chip.getPsramVendor(loader) !== "AP_3v3"
      || await loader.getFlashSize() !== 16 * 1024) {
    throw new Error("This MeshGangs release requires the original Heltec V4 with 2 MB PSRAM and 16 MB flash. V4 R8 is not supported.");
  }
  const table = await loader.readFlash(0x8000, 0x1000);
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let fits = false;
  for (let offset = 0; offset + 32 <= view.byteLength; offset += 32) {
    if (view.getUint16(offset, true) !== 0x50aa) break;
    const type = view.getUint8(offset + 2);
    const subtype = view.getUint8(offset + 3);
    const start = view.getUint32(offset + 4, true);
    const capacity = view.getUint32(offset + 8, true);
    if (type === 0 && [0, 0x10].includes(subtype) && start === 0x10000 && capacity >= size) fits = true;
  }
  if (artifact.address !== 0x10000 || !fits) {
    throw new Error("The existing V4 partition layout cannot accept this app-only update. Its bootloader and saved data were left untouched.");
  }
}

async function flashEsp32(artifact, bytes) {
  if (!artifact.md5) throw new Error("This catalog has no device-verification MD5. The deployment is incomplete; flashing was blocked.");
  const deskosUpdate = state.device.id === "deskos-d1l" && state.install === "update";
  const bootSelection = deskosUpdate ? state.profile.update_boot : null;
  if (deskosUpdate && (artifact.address !== 0x20000 || !bootSelection?.md5 || bootSelection.address !== 0xf000 || bootSelection.size !== 0x2000)) {
    throw new Error("The DeskOS boot selection file is missing or invalid. Flashing was blocked.");
  }
  const bootBytes = bootSelection ? await fetchFirmware(bootSelection) : null;
  if (state.cli) {
    await state.cli.disconnect();
    state.cli = null;
  }
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
    if (isMeshGangsSidecar()) {
      await verifyMeshGangsFlashHardware(loader, port, artifact, bytes.byteLength);
      flashLog("Collector hardware confirmed. Creating its one-time MeshGangs credential; secret values stay hidden…");
      await enrollMeshGangsDevice();
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
    if (bootSelection) {
      setProgress("Selecting the verified DeskOS update", 95);
      await loader.writeFlash({
        fileArray: [{ data: bytesToBinaryString(bootBytes), address: bootSelection.address }],
        flashSize: "keep", flashMode: "keep", flashFreq: "keep",
        eraseAll: false, compress: true,
      });
      const bootMd5 = await loader.flashMd5sum(bootSelection.address, bootBytes.byteLength);
      const bootDigest = typeof bootMd5 === "string" ? bootMd5.toLowerCase() : [...bootMd5].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (bootDigest !== bootSelection.md5.toLowerCase()) throw new Error("DeskOS boot selection verification failed.");
      flashLog("The verified DeskOS update is selected for the next boot.");
    }
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
  if (state.flashing) return;
  const button = $("#flash-button");
  state.deskosVerified = null;
  state.maxStep = 3;
  enableThrough(3);
  if (!navigator.serial) {
    resetLog($("#flash-log"), "ERROR: Web Serial is unavailable. Use current desktop Chrome or Edge; Safari and Firefox are not supported.");
    return;
  }
  if (isMeshGangsSidecar() && state.meshGangsProvisioned) {
    resetMeshGangsDeviceWorkflow();
  }
  playModem("dial");
  state.flashing = true;
  const selectionPanels = $$('.stepper, [data-panel="1"], [data-panel="2"]');
  selectionPanels.forEach((panel) => { panel.inert = true; });
  button.disabled = true;
  resetLog($("#flash-log"), "ATZ\nATDT USB://NEONPOCKET\nNEGOTIATING FAIL-CLOSED FLASH LINE…");
  setProgress("Downloading exact release", 1);
  let completed = false;
  try {
    const artifact = currentArtifact();
    const bytes = await fetchFirmware(artifact);
    if (state.device.flash_method === "esp32") await flashEsp32(artifact, bytes);
    else await flashUf2(artifact, bytes);
    flashLog("Firmware write completed. Keep USB connected.");
    completed = true;
  } catch (error) {
    flashLog(`ERROR: ${error.message}`);
    setProgress("Stopped safely", 0);
  } finally {
    state.flashing = false;
    selectionPanels.forEach((panel) => { panel.inert = false; });
    button.disabled = !navigator.serial;
  }
  if (completed) {
    enableThrough(4);
    goToStep(4);
  }
}

async function readBootSample(port, durationMs = 6000) {
  await port.open({ baudRate: 115200 });
  const decoder = new TextDecoder();
  const reader = port.readable.getReader();
  let output = "";
  const deadline = Date.now() + durationMs;
  let pendingRead = reader.read();
  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        pendingRead,
        sleep(350).then(() => ({ timeout: true })),
      ]);
      if (result.timeout) continue;
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      if (output.length > 24000) output = output.slice(-24000);
      pendingRead = reader.read();
    }
  } finally {
    try { await reader.cancel(); } catch (_error) {}
    reader.releaseLock();
    await port.close();
  }
  return output;
}

function base64Utf8(value) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

async function enrollMeshGangsDevice() {
  if (state.meshGangsEnrollment) return;
  if (!state.meshGangsToken || !meshGangsInputsValid()) {
    throw new Error("Link your MeshGangs account and complete the selected role before flashing.");
  }
  const status = $("#meshgangs-account-state");
  status.textContent = "AUTH challenge";
  status.classList.remove("ready", "error", "pending");
  status.classList.add("working");
  let payload;
  try {
    const response = await fetch("https://mg.canadaverse.org/api/v1/flasher/enroll", {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.meshGangsToken,
        label: $("#meshgangs-label").value.trim(),
        role: state.meshGangsRole,
      }),
    });
    payload = await response.json().catch(() => null);
    if (!response.ok) {
      const code = payload?.code || `HTTP_${response.status}`;
      throw new Error(`MeshGangs account link was not accepted (${code}). Start a new flasher link from your profile.`);
    }
    const hex64 = /^[0-9a-f]{64}$/i;
    const expectedCredential = payload?.role === "mobile" ? "relay_key" : "device_key";
    if (payload?.schema !== "meshgangs.flasher-enrollment.v1"
      || payload.role !== state.meshGangsRole
      || !Number.isInteger(payload.device?.id)
      || typeof payload.device?.label !== "string"
      || payload.credential_kind !== expectedCredential
      || !hex64.test(payload.credential || "")) {
      throw new Error("MeshGangs returned an invalid enrollment response; setup stopped safely.");
    }
    state.meshGangsEnrollment = {
      role: payload.role,
      device: payload.device,
      secret: payload.credential,
    };
    state.meshGangsToken = null;
    state.meshGangsTokenError = false;
    payload.credential = "";
    updateMeshGangsSetup();
    updateContinueState();
    flashLog("AUTH OK: scoped MeshGangs credential is held only in this tab until USB setup completes.");
  } catch (error) {
    status.textContent = "Account link failed";
    status.classList.remove("ready", "working", "pending");
    status.classList.add("error");
    throw error;
  } finally {
    payload = null;
  }
}

async function exchangeMeshGangsSerial(port, command, pattern, timeout = 12000) {
  let reader;
  let writer;
  let output = "";
  try {
    await port.open({ baudRate: 115200 });
    writer = port.writable.getWriter();
    reader = port.readable.getReader();
    await writer.write(new TextEncoder().encode(`${command}\r\n`));
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeout;
    let pendingRead = reader.read();
    while (Date.now() < deadline) {
      const result = await Promise.race([
        pendingRead,
        sleep(300).then(() => ({ timeout: true })),
      ]);
      if (result.timeout) continue;
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
      if (output.length > 24000) output = output.slice(-24000);
      if (pattern.test(output)) return output;
      pendingRead = reader.read();
    }
  } finally {
    try { await reader?.cancel(); } catch (_error) {}
    try { reader?.releaseLock(); } catch (_error) {}
    try { writer?.releaseLock(); } catch (_error) {}
    try { await port.close(); } catch (_error) {}
  }
  throw new Error("The MeshGangs collector did not return the expected USB response.");
}

async function provisionMeshGangs(port) {
  const enrollment = state.meshGangsEnrollment;
  if (!enrollment?.secret) throw new Error("The one-time MeshGangs credential is no longer available in this tab.");
  if (!meshGangsAllowedRoles().includes(enrollment.role)) throw new Error("This collector does not support the selected role.");
  let command = "";
  const expected = enrollment.role === "usb" ? "USB" : enrollment.role === "wifi" ? "WIFI" : "MOBILE";
  if (enrollment.role === "usb") {
    command = "CFG:MG1:USB";
  } else if (enrollment.role === "wifi") {
    command = `CFG:MG1:WIFI:${base64Utf8($("#meshgangs-wifi-ssid").value)}:${base64Utf8($("#meshgangs-wifi-password").value)}:${enrollment.secret}`;
  } else {
    command = `CFG:MG1:MOBILE:${enrollment.secret}`;
  }
  try {
    const reply = await exchangeMeshGangsSerial(
      port,
      command,
      /RSP:mgprovision:(?:OK:(?:USB|WIFI|MOBILE)|ERROR)/,
      15000,
    );
    if (/RSP:mgprovision:ERROR/.test(reply)) throw new Error("The collector rejected the selected MeshGangs role or credential.");
    if (!reply.includes(`RSP:mgprovision:OK:${expected}`)) throw new Error("The collector confirmed a different role than the one selected.");
  } finally {
    command = "";
  }
}

async function waitForMeshGangsReady(port) {
  const role = state.meshGangsEnrollment.role;
  const expected = role === "usb" ? "USB_READY" : role === "wifi" ? "READY" : "MOBILE_READY";
  const deadline = Date.now() + (role === "wifi" ? 120000 : 30000);
  let lastStatus = "";
  await sleep(3000);
  while (Date.now() < deadline) {
    try {
      const reply = await exchangeMeshGangsSerial(
        port,
        "CMD:mgstatus:",
        /MeshGangs status: [A-Z_]+/,
        6000,
      );
      if (/storage(?:_| )?(?:layout(?:_| )?)?error|radio init failed|SX1262 init failed|display failed to start|guru meditation|panic|assert failed/i.test(reply)) {
        throw new Error("The MeshGangs collector reported a hardware or storage failure after setup.");
      }
      const status = reply.match(/MeshGangs status: ([A-Z_]+)/)?.[1] || "UNKNOWN";
      if (status !== lastStatus) {
        bootLog(`MeshGangs status: ${status}`);
        lastStatus = status;
      }
      if (status === expected) return;
      if (status === "AUTH_ERROR") throw new Error("MeshGangs rejected the new device key.");
    } catch (error) {
      if (/reported a hardware|rejected the new device key/.test(error.message)) throw error;
    }
    await sleep(1500);
  }
  throw new Error(role === "wifi"
    ? "The collector saved Home Wi-Fi setup but did not authenticate within two minutes. Check the 2.4 GHz network details."
    : `The collector saved setup but did not reach ${expected}.`);
}

function parseCliJson(reply, command) {
  try {
    return JSON.parse(reply);
  } catch (_error) {
    throw new Error(`DeskOS returned an unreadable ${command} reply.`);
  }
}

async function waitForDeskOsVersion(cli) {
  const deadline = performance.now() + 120000;
  let explained = false;
  while (performance.now() < deadline) {
    try {
      return parseCliJson(await cli.command("version", {
        timeout: Math.max(1, Math.min(5000, deadline - performance.now())),
      }), "version");
    } catch (error) {
      if (error.code !== "CLI_TIMEOUT") throw error;
      if (!explained) {
        deskosLog("DeskOS is still loading saved history. Keep USB connected; startup can take up to two minutes.");
        explained = true;
      }
    }
  }
  throw new Error("DeskOS did not finish startup within two minutes. Keep USB connected and check the device display.");
}

async function verifyDeskOsIdentity(port) {
  state.deskosVerified = null;
  resetLog($("#deskos-log"), "Checking the installed DeskOS identity over USB…");
  let cli;
  try {
    cli = await connectConsole(port);
    const version = await waitForDeskOsVersion(cli);
    const expectedVersion = state.device.tag.replace(/^v/, "");
    if (!version.ok || version.firmware !== "MeshCore DeskOS D1L") throw new Error("The connected device did not identify itself as DeskOS D1L.");
    if (version.version !== expectedVersion) throw new Error(`Wrong DeskOS version: device ${version.version}, expected ${expectedVersion}.`);
    if (version.build_commit !== state.device.commit) throw new Error("DeskOS build commit does not match the selected release.");
    if (version.release_profile !== "full_feature") throw new Error("The installed DeskOS profile does not match the selected full-feature release.");

    const health = parseCliJson(await cli.command("health", { timeout: 12000 }), "health");
    if (!health.ok || !health.board_ready || !health.ui_ready) throw new Error("DeskOS started, but its board or interface is not ready.");
    if (["PANIC", "INT_WDT", "TASK_WDT", "WDT"].includes(health.reset_reason)) {
      throw new Error("DeskOS restarted after a fault. Check the device before finishing the update.");
    }
    const mesh = parseCliJson(await cli.command("mesh status", { timeout: 12000 }), "mesh status");
    if (!mesh.ok || !mesh.radio_ready || !mesh.identity_ready || !mesh.companion_framing_ready) {
      throw new Error("DeskOS started, but its radio or identity is not ready.");
    }
    const storage = parseCliJson(await cli.command("storage status", { timeout: 12000 }), "storage status");
    if (!storage.ok) throw new Error("DeskOS started, but storage is not ready.");
    if (health.build_commit !== state.device.commit || mesh.build_commit !== state.device.commit || storage.build_commit !== state.device.commit) {
      throw new Error("DeskOS changed builds during verification. Verify the device again.");
    }

    state.deskosVerified = { version, health, mesh, storage };
    $("#deskos-release").textContent = `v${version.version}`;
    $("#deskos-build").textContent = version.build_commit.slice(0, 12);
    const setup = reflectDeskOsStorage(storage);
    $("#deskos-health").textContent = setup.sdReady ? "Firmware and SD ready" : "Firmware ready; finish setup";
    deskosLog(`PASS: DeskOS ${version.version}`);
    deskosLog(`PASS: exact build ${version.build_commit}`);
    deskosLog(`PASS: board and interface ready`);
    deskosLog("PASS: radio and identity ready");
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
    if (state.device.id !== "deskos-d1l") {
      bootLog("Listening briefly for startup output…");
      const sample = await readBootSample(port);
      if (sample.trim()) bootLog(sample.trim());
      else bootLog("No text startup log was emitted; USB enumeration succeeded.");
      if (/storage(?:_| )?(?:layout(?:_| )?)?error|radio init failed|SX1262 init failed|display failed to start|guru meditation|panic|assert failed/i.test(sample)) {
        throw new Error("Startup output contains a fatal error. Do not disconnect USB.");
      }
    }
    if (isMeshGangsSidecar() && !state.meshGangsProvisioned) {
      if (!state.meshGangsEnrollment) throw new Error("The MeshGangs account enrollment is missing; return to the build step and link the account again.");
      if (state.device.id === "heltec-v4") {
        const identity = await exchangeMeshGangsSerial(port, "CMD:MG1:INFO", /MG1 INFO [^\r\n]+/, 12000);
        if (!identity.split(/\r?\n/).includes(`MG1 INFO meshgangs-v4 ${state.profile.tag}`)) {
          throw new Error("The restarted V4 did not confirm the selected MeshGangs release. No credentials were sent.");
        }
      }
      bootLog(`Applying the exclusive ${state.meshGangsEnrollment.role} role over USB; secret values are hidden…`);
      await provisionMeshGangs(port);
      bootLog("PASS: the collector confirmed that its role was saved; verifying the restarted collector…");
      await waitForMeshGangsReady(port);
      if (state.meshGangsEnrollment.role === "usb") {
        state.meshGangsUsbKey = state.meshGangsEnrollment.secret;
      } else if (state.meshGangsEnrollment.role === "wifi") {
        $("#meshgangs-wifi-ssid").value = "";
        $("#meshgangs-wifi-password").value = "";
      }
      state.meshGangsEnrollment.secret = null;
      state.meshGangsProvisioned = true;
      bootLog("PASS: MeshGangs role and startup state verified over USB.");
    }
    if (state.device.id === "deskos-d1l") {
      bootLog("Verifying the exact DeskOS release and health…");
      await verifyDeskOsIdentity(port);
      bootLog(`PASS: DeskOS ${state.deskosVerified.version.version} matches ${state.device.commit.slice(0, 12)}.`);
    }
    bootLog(state.device.id === "deskos-d1l"
      ? "PASS: the expected USB device returned and DeskOS checks passed."
      : "PASS: the expected USB device returned without a detected fatal startup marker.");
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
  const meshGangs = type === "meshgangs-sidecar";
  const companion = type.startsWith("companion");
  const repeaterWeb = type === "repeater-web";
  const ulp = type === "ulp-repeater";
  $("#companion-onboarding").classList.toggle("hidden", !(companion || repeaterWeb));
  $("#deskos-onboarding").classList.toggle("hidden", !deskos);
  $("#wdg-onboarding").classList.toggle("hidden", !wdgSidecar);
  $("#meshgangs-onboarding").classList.toggle("hidden", !meshGangs);
  $("#server-onboarding").classList.toggle("hidden", companion || repeaterWeb || deskos || wdgSidecar || meshGangs);
  if (meshGangs) {
    renderMeshGangsOnboarding();
    return;
  }
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
  if (companion || repeaterWeb) {
    const usb = type === "companion-usb";
    const web = type === "companion-web";
    const headless = type === "companion-headless";
    const headlessWeb = web && state.device.id === "rcc6-headless-companion";
    const screenLabel = /oled/i.test(state.device.display) ? "OLED" : "TFT";
    $("#companion-instructions").textContent = repeaterWeb
      ? "Read the setup AP, key and address from the OLED. Join it, open 192.168.4.1, then configure local Wi-Fi and the repeater. The OLED shows the LAN IP after joining. This role has no BLE, companion TCP or MQTT."
      : headlessWeb
      ? "Keep USB connected after restart and open the 115200-baud serial console below. It prints the setup AP, device key and address. Join the AP and complete Local Wi-Fi Setup. On your LAN, sign in with meshcore and that same eight-letter device key—not the home Wi-Fi password. The console prints the new IP. TCP/5000 is a full companion/admin interface for trusted LANs only."
      : web
        ? `Read the AP name, device key and address from the ${screenLabel}, connect to it, and complete Local Wi-Fi Setup. On your LAN, sign in with meshcore and that same eight-letter device key—not the home Wi-Fi password. The ${screenLabel} shows the new IP. TCP/5000 is a full companion/admin interface for trusted LANs only.`
      : usb
        ? "Keep USB connected and open a desktop MeshCore companion that supports the standard serial transport. Select the NeonPocket serial device; this is the binary companion protocol, not the text CLI."
        : headless
          ? "Open a standard MeshCore companion app, select the advertised NeonPocket device, and pair with PIN 123456. This build has no display; radio preset, name and channels are managed through the companion app."
          : "Open a standard MeshCore companion app, select the advertised NeonPocket device, and use the PIN shown on its screen. Radio preset, name and channels are managed through the companion app.";
    $("#companion-check-connect").textContent = repeaterWeb
      ? " I opened the protected repeater dashboard using the OLED setup key."
      : usb
      ? " My desktop companion connected to the NeonPocket serial device."
      : web
        ? " I opened the LAN WebUI with meshcore and the eight-letter device key."
        : headless
          ? " I paired or connected using PIN 123456."
          : " I paired or connected using the PIN shown by the device.";
    $("#companion-check-sync").textContent = repeaterWeb
      ? " The node name, legal radio preset, forwarding and LAN address are correct."
      : " My identity, contacts and channels loaded correctly.";
    return;
  }
  const network = type.includes("network");
  const room = type.startsWith("room");
  $("#network-fields").classList.toggle("hidden", !network);
  $("#guest-password-field").classList.toggle("hidden", !room);
  $("#ulp-fields").classList.toggle("hidden", !ulp);
  $("#ulp-note").classList.toggle("hidden", !ulp);
  $("#wifi-ssid").required = network;
  $("#mqtt-iata").required = network;
  $("#guest-password").required = room;
  $("#onboarding-heading").textContent = ulp
    ? "The USB wizard applies radio, security and default-on ULP power settings, then verifies them after reboot."
    : network
      ? "The USB wizard applies radio, Wi-Fi, MQTT and security settings, reboots, verifies saved values and reports the LAN IP."
      : "The USB wizard applies and verifies the node, radio, forwarding and security settings before deployment.";
}

function renderMeshGangsOnboarding() {
  const role = state.meshGangsEnrollment?.role || state.meshGangsRole;
  const checks = $("#meshgangs-ready-checks");
  $("#meshgangs-usb-key").classList.toggle("hidden", role !== "usb" || !state.meshGangsUsbKey);
  $("#meshgangs-usb-key-value").textContent = state.meshGangsUsbKey || "";
  if (role === "usb") {
    $("#onboarding-heading").textContent = "Home USB collector configured.";
    $("#meshgangs-ready-title").textContent = "Home USB is ready";
    $("#meshgangs-ready-copy").textContent = "The radio has no Wi-Fi or game key. Keep this one-time key for the Windows/Linux uploader, which will own uploads.";
    checks.innerHTML = "<label>✓ Radio role verified as <strong>USB_READY</strong>.</label><label>✓ Radio Wi-Fi and relay credentials were cleared.</label><label>Next: download the setup file, install the desktop uploader, and select this collector.</label>";
  } else if (role === "wifi") {
    $("#onboarding-heading").textContent = "Home Wi-Fi collector configured.";
    $("#meshgangs-ready-title").textContent = "Home Wi-Fi is online";
    $("#meshgangs-ready-copy").textContent = "The collector joined the selected 2.4 GHz network and authenticated directly with MeshGangs. USB is no longer required.";
    checks.innerHTML = "<label>✓ Radio role verified as <strong>READY</strong>.</label><label>✓ BLE patrol relay is disabled in this role.</label><label>Place the powered collector at home with its LoRa antenna attached.</label>";
  } else {
    $("#onboarding-heading").textContent = "Mobile BLE companion configured.";
    $("#meshgangs-ready-title").textContent = "Mobile V3 is ready to pair";
    $("#meshgangs-ready-copy").textContent = "The collector has only its scoped phone-relay credential. Android supplies GPS and internet; the radio does not join Wi-Fi.";
    checks.innerHTML = "<label>✓ Radio role verified as <strong>MOBILE_READY</strong>.</label><label>✓ Radio Wi-Fi and direct-upload key were cleared.</label><label>Next: unplug USB, open MeshGangs on Android, select this V3, and start a patrol.</label>";
  }
}

async function copyMeshGangsUsbKey() {
  if (!state.meshGangsUsbKey) return;
  await navigator.clipboard.writeText(state.meshGangsUsbKey);
  $("#meshgangs-copy-key").textContent = "Copied";
}

function downloadMeshGangsUsbKey() {
  if (!state.meshGangsUsbKey) return;
  const setup = {
    schema: "meshgangs.desktop-enrollment.v1",
    server: "https://mg.canadaverse.org",
    label: state.meshGangsEnrollment?.device?.label || $("#meshgangs-label").value.trim(),
    device_key: state.meshGangsUsbKey,
  };
  const blob = new Blob([`${JSON.stringify(setup, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "meshgangs-home-usb-setup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

class CliSession {
  constructor(port, { jsonReplies = false, deviceId = null } = {}) {
    this.port = port;
    this.jsonReplies = jsonReplies;
    this.deviceId = deviceId;
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
    let failure = new Error("console disconnected");
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop();
        if (this.buffer.length > 65536 || lines.some((line) => line.length > 65536)) {
          throw new Error("USB console response exceeded its supported size");
        }
        lines.forEach((line) => this.onLine(line));
      }
    } catch (error) {
      failure = error;
      if (this.running) serialLog(`*** Console disconnected: ${error.message}`);
    } finally {
      this.running = false;
      this.rejectWaiter(failure);
    }
  }

  rejectWaiter(error, expected = this.waiter) {
    if (!expected || this.waiter !== expected) return;
    this.waiter = null;
    clearTimeout(expected.timer);
    expected.reject(error);
  }

  onLine(line) {
    serialLog(this.waiter?.secret ? "[hidden console reply]" : line);
    const waiter = this.waiter;
    if (!waiter) return;
    let reply;
    if (this.jsonReplies) {
      const start = line.indexOf("{");
      if (start < 0) return;
      reply = line.slice(start).trim();
      let parsed;
      try { parsed = JSON.parse(reply); } catch (_error) { return; }
      if (parsed.schema !== 1 || typeof parsed.ok !== "boolean" || typeof parsed.cmd !== "string" || !parsed.cmd
        || (waiter.command !== parsed.cmd && !waiter.command.startsWith(`${parsed.cmd} `))) return;
    } else {
      if (!/^\s*->/.test(line)) return;
      reply = line.replace(/^\s*->\s*/, "").trim();
    }
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  async write(command, display = command) {
    serialLog(`> ${display}`);
    await this.writer.write(new TextEncoder().encode(`${command}\r\n`));
  }

  async command(command, { secret = false, timeout = 7000 } = {}) {
    if (!this.running) throw new Error("console disconnected");
    if (this.waiter) throw new Error("another CLI command is still pending");
    let waiter;
    const response = new Promise((resolve, reject) => {
      waiter = { resolve, reject, command, secret, timer: null };
      const timer = setTimeout(() => {
        const error = new Error(`No CLI reply for ${secret ? "a secret setting" : command}`);
        error.code = "CLI_TIMEOUT";
        this.rejectWaiter(error, waiter);
      }, timeout);
      waiter.timer = timer;
      this.waiter = waiter;
    });
    this.write(command, secret ? `${command.split(" ").slice(0, 2).join(" ")} [hidden]` : command)
      .catch((error) => this.rejectWaiter(error, waiter));
    const reply = await response;
    if (/^(error|err|unknown|\?\?)/i.test(reply)) {
      throw new Error(secret ? "A secret setting was rejected" : `${command.split(" ")[0]} failed: ${reply}`);
    }
    return reply;
  }

  async disconnect() {
    this.running = false;
    this.rejectWaiter(new Error("console disconnected"));
    try { await this.reader?.cancel(); } catch (_error) {}
    try { this.reader?.releaseLock(); } catch (_error) {}
    try { this.writer?.releaseLock(); } catch (_error) {}
    try { await this.port.close(); } catch (_error) {}
  }
}

async function connectConsole(port = null) {
  const jsonReplies = state.device.id === "deskos-d1l";
  if (state.cli?.running && (!port || state.cli.port === port)
    && state.cli.deviceId === state.device.id && state.cli.jsonReplies === jsonReplies
    && portMatchesDevice(state.cli.port, state.device)) return state.cli;
  if (state.cli) {
    await state.cli.disconnect();
    state.cli = null;
  }
  const selected = port || state.port || await navigator.serial.requestPort({ filters: usbFilters(state.device) });
  if (!portMatchesDevice(selected, state.device)) throw new Error("The selected USB device does not match the chosen hardware.");
  resetLog($("#serial-log"), "Opening 115200 baud MeshCore CLI…");
  const cli = new CliSession(selected, { jsonReplies, deviceId: state.device.id });
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
  const ulp = state.profile.onboarding === "ulp-repeater";
  const config = {
    name: $("#node-name").value.trim(),
    preset,
    tx: $("#tx-power").value,
    repeat: $("#repeat-mode").value,
    admin: $("#admin-password").value,
    guest: room ? $("#guest-password").value : "",
    network,
    room,
    ulp,
    ulpProfile: ulp ? $("#ulp-profile").value : "",
    ulpLocationPolicy: ulp ? $("#ulp-location-share").value : "",
    latitude: ulp ? $("#ulp-latitude").value.trim() : "",
    longitude: ulp ? $("#ulp-longitude").value.trim() : "",
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
  if (ulp) {
    const hasLatitude = config.latitude !== "";
    const hasLongitude = config.longitude !== "";
    if (hasLatitude !== hasLongitude) throw new Error("Enter both latitude and longitude, or leave both blank to keep the saved location.");
    if (hasLatitude && (!Number.isFinite(Number(config.latitude)) || Number(config.latitude) < -90 || Number(config.latitude) > 90)) throw new Error("Latitude must be from -90 to 90.");
    if (hasLongitude && (!Number.isFinite(Number(config.longitude)) || Number(config.longitude) < -180 || Number(config.longitude) > 180)) throw new Error("Longitude must be from -180 to 180.");
  }
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
  if (config.ulp) {
    commands.push([`ulp ${config.ulpProfile}`]);
    if (config.latitude !== "") {
      commands.push([`set lat ${Number(config.latitude).toFixed(6)}`]);
      commands.push([`set lon ${Number(config.longitude).toFixed(6)}`]);
    }
    commands.push([`gps advert ${config.ulpLocationPolicy}`]);
  }
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
  if (config.ulp) {
    const status = await cli.command("ulp");
    const checks = {
      on: /ULP on.*level=5.*preamble=16/i,
      conservative: /ULP on/i,
      max: /ULP on.*level=10.*preamble=32/i,
      off: /ULP off/i,
    };
    if (!checks[config.ulpProfile].test(status)) {
      throw new Error(`Verification failed for ULP profile: device replied '${status}'.`);
    }
    const locationPolicy = await cli.command("gps advert");
    if (!locationPolicy.toLowerCase().includes(config.ulpLocationPolicy)) {
      throw new Error(`Verification failed for advert location: device replied '${locationPolicy}'.`);
    }
    if (config.latitude !== "") {
      const actualLatitude = Number.parseFloat(await cli.command("get lat"));
      const actualLongitude = Number.parseFloat(await cli.command("get lon"));
      if (!Number.isFinite(actualLatitude) || Math.abs(actualLatitude - Number(config.latitude)) > 0.000001) throw new Error("Saved latitude did not verify.");
      if (!Number.isFinite(actualLongitude) || Math.abs(actualLongitude - Number(config.longitude)) > 0.000001) throw new Error("Saved longitude did not verify.");
    }
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
    await verifyDeskOsIdentity(selected);
    const cli = state.cli;
    let storage = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      storage = parseCliJson(
        await cli.command("storage status", { timeout: 12000 }),
        "storage status",
      );
      if (storage.build_commit !== state.device.commit) {
        throw new Error("DeskOS changed builds during storage verification. Verify the device again.");
      }
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
        if (result.retainedIssue) {
          throw new Error("DeskOS reports an unresolved history-storage problem. Check Storage on the D1L and verify again after it recovers.");
        }
        throw new Error(result.needsFat32
          ? "Use an existing FAT32 card, then run Prepare again. This tool does not format cards."
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
  if (!deskOsFirmwareVerified()) {
    await verifyBoot();
    return;
  }
  const storage = state.deskosVerified?.storage;
  const { bridgeReady, sdReady, retainedIssue } = deskOsStorageReadiness(storage);
  if (retainedIssue) {
    await verifyDeskOsStorage("sd");
  } else if (!bridgeReady) {
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
  $("#modem-audio-toggle").addEventListener("click", toggleModemAudio);
  $("#change-device-family").addEventListener("click", showDeviceFamilies);
  $$('[data-go]').forEach((button) => button.addEventListener("click", () => goToStep(Number(button.dataset.go))));
  $$('input[name="install"]').forEach((radio) => radio.addEventListener("change", () => selectInstallMode(radio.value)));
  $("#model-confirm").addEventListener("change", updateContinueState);
  $("#deskos-clean-checkbox").addEventListener("change", updateContinueState);
  $("#meshgangs-enroll-link").addEventListener("click", saveMeshGangsHandoff);
  $$('input[name="meshgangs-role"]').forEach((radio) => radio.addEventListener("change", () => {
    if (state.flashing) return;
    state.meshGangsRole = radio.value;
    updateMeshGangsSetup();
    updateContinueState();
  }));
  ["#meshgangs-label", "#meshgangs-wifi-ssid", "#meshgangs-wifi-password"].forEach((selector) => {
    $(selector).addEventListener("input", updateContinueState);
  });
  $("#to-flash").addEventListener("click", () => {
    if (state.flashing) return;
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
  $("#meshgangs-copy-key").addEventListener("click", async () => {
    try { await copyMeshGangsUsbKey(); } catch (_error) { $("#meshgangs-copy-key").textContent = "Copy failed"; }
  });
  $("#meshgangs-download-key").addEventListener("click", downloadMeshGangsUsbKey);
  $("#serial-command").addEventListener("keydown", (event) => { if (event.key === "Enter") sendManualCommand(); });
}

async function init() {
  state.stepperTop = $(".stepper").offsetTop;
  captureMeshGangsEnrollment();
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
    populateOptions();
    const params = new URLSearchParams(location.search);
    const deviceId = params.get("device");
    const profileId = params.get("profile");
    const device = state.catalog.devices.find((candidate) => candidate.id === deviceId);
    const profile = device?.profiles.find((candidate) => candidate.id === profileId);
    if (device && profile) {
      state.deviceFamily = deviceFamilies.find((family) => family.deviceIds.includes(device.id))?.id || null;
      renderDevices();
      selectDevice(device.id);
      selectProfile(profile.id);
    } else {
      renderDevices();
    }
  } catch (error) {
    $("#compatibility").textContent = `Firmware catalog failed to load: ${error.message}`;
    $("#compatibility").classList.remove("hidden");
  }
}

init();
