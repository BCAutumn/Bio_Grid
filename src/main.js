import { createWorld } from './sim/index.js';
import { drawCellValuesOverlay, drawChart, drawFlowOverlay, paintWorldToPixelsView, updateSkyBadge } from './render.js';
import { bindInteractions } from './main-interactions.js';
import { createSharedChannels } from './main-shared-channels.js';
import { getMainDom } from './main-dom.js';
import { bindSidebarTabs } from './main-tabs.js';

const params = new URLSearchParams(globalThis.location?.search || '');
const parseDim = (v, fallback) => {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(4, Math.min(5000, i));
};
const GRID_W = parseDim(params.get('w'), 240);
const GRID_H = parseDim(params.get('h'), 240);
const parseCanvas = (v, fallback) => {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(320, Math.min(1400, i));
};
// 默认把画布边长压小一点：单格看起来不会“太大”，也更省渲染开销。
const CANVAS_SIDE_DEFAULT = parseCanvas(params.get('canvas'), 720);
const HISTORY_MAX = 600;
const BASE_HINT = '当前模式：播种。左键拖动绘制；滚轮缩放；中键拖动平移。';
const CELL_VALUES_MIN_ZOOM = 8;
const PANEL_MIN_INTERVAL_MS = 80;
const CHART_MIN_INTERVAL_MS = 96;
const RENDER_INTERVAL_MS = 15;
const TRANSFER_RENDER_INTERVAL_MS = 120;
const TAICHI_RENDER_INTERVAL_MS = 16;
const TAICHI_TRANSFER_RENDER_INTERVAL_MS = 120;
const TAICHI_RENDER_INTERVAL_HIGH_MS = 24;
const TAICHI_RENDER_INTERVAL_TURBO_MS = 36;
const TAICHI_RENDER_INTERVAL_ULTRA_MS = 52;
const CTRL_WRITE_SLOT = 0;
const CTRL_VERSION = 1;
const RENDER_MODE_WORKER = 'worker';
const ACTUAL_TPS_SMOOTHING = 0.2;
const ACTUAL_FPS_SMOOTHING = 0.2;

const ENGINE_PARAM = String(params.get('engine') || 'auto').toLowerCase();
const BACKEND_HEALTH_TIMEOUT_MS = 450;
async function backendHealthy() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), BACKEND_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!data?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

const ENGINE = (ENGINE_PARAM === 'taichi' || (ENGINE_PARAM !== 'js' && await backendHealthy())) ? 'taichi' : 'worker';
let backendReady = ENGINE !== 'taichi';
let pendingTaichiCanvasSize = null;
let pendingTaichiView = null;
let pendingTaichiBrushMessage = null;
let taichiBrushInFlight = false;

const world = ENGINE === 'taichi'
  ? {
      width: GRID_W,
      height: GRID_H,
      size: GRID_W * GRID_H,
      time: 0,
      day: 0,
      sunlight: 0,
      config: { timeStep: 0.05, sunSpeed: 0.014, polarDay: false, maxEnergy: 40 },
      stats: { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, normalizedBiomass: 0, senescentRatio: 0, sunlight: 0 }
    }
  : createWorld(GRID_W, GRID_H);

const simWorker = ENGINE === 'worker'
  ? new Worker(new URL('./workers/sim-worker/index.js', import.meta.url), { type: 'module' })
  : null;
let pendingSnapshot = null;
let pendingSnapshotMeta = null;

const supportsSharedSnapshots = ENGINE === 'worker' && typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
const supportsOffscreenWorker = ENGINE === 'worker'
  && typeof OffscreenCanvas !== 'undefined'
  && typeof HTMLCanvasElement !== 'undefined'
  && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';

const dom = getMainDom();
const { simCanvas, chartCanvas, skyOrbit, orbit, panel, buttons, inputs, tabs } = dom;
const simPerfHud = document.getElementById('simPerfHud');

const gridMeta = document.getElementById('gridMeta');
if (gridMeta) {
  const byParams = (params.has('w') || params.has('h')) ? '（来自 URL 参数）' : '';
  gridMeta.textContent = `World: ${GRID_W}×${GRID_H}${byParams} / Engine: ${ENGINE}`;
}
if ((params.has('w') || params.has('h')) && (GRID_W <= 8 || GRID_H <= 8)) {
  panel.hint.textContent = `当前世界尺寸为 ${GRID_W}×${GRID_H}（来自 URL 参数）。把地址栏参数改成 ?w=240&h=240 或直接去掉参数即可。`;
}
if (ENGINE === 'taichi') {
  panel.hint.textContent = 'Taichi 后端已探测到，正在初始化...';
}

const {
  btnPause, btnReset, btnSeed, btnViewReset, btnCellValues, btnAgingGlow,
  btnPolarDay,
  btnModeLife, btnModeDisturb, btnModeAnnihilate, btnModeWall, btnModeErase,
  btnModeLightUp, btnModeLightDown, btnModeLossUp, btnModeLossDown,
  btnShapeCircle, btnShapeSquare, btnShapeRect, btnShapeTriangle,
  btnPresetEmpty, btnPresetFourRooms, btnPresetMaze,
  btnPresetFiveZones, btnPresetHourglass, btnPresetRings, btnPresetVerticalGradient,
  btnViewEco, btnViewTerrainLight, btnViewTerrainLoss, btnViewTerrainMix, btnViewTransfer,
  btnMapUndo, btnMapRedo, btnTerrainUniformReset
} = buttons;

const {
  speedInput, speedValue,
  radiusInput, radiusInputMap, geneInput, radiusValue, radiusValueMap, geneValue,
  sunSpeedInput, sunSpeedValue,
  zoomInput, zoomValue,
  terrainStrengthInput, terrainStrengthValue
} = inputs;

let simCtx = null;
let simOffscreen = null;
if (supportsOffscreenWorker) simOffscreen = simCanvas.transferControlToOffscreen();
else simCtx = simCanvas.getContext('2d', { alpha: false });

let simTargetWidth = CANVAS_SIDE_DEFAULT;
let simTargetHeight = CANVAS_SIDE_DEFAULT;
const sharedChannels = supportsSharedSnapshots && !simOffscreen ? createSharedChannels(world.size) : null;
const chartCtx = chartCanvas.getContext('2d', { alpha: true });

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

let bufferCanvas = null;
let bufferCtx = null;
let frame = null;
if (simCtx) {
  bufferCanvas = document.createElement('canvas');
  bufferCanvas.width = simCanvas.width;
  bufferCanvas.height = simCanvas.height;
  bufferCtx = bufferCanvas.getContext('2d', { alpha: false });
  frame = bufferCtx.createImageData(bufferCanvas.width, bufferCanvas.height);
}

const history = { biomass: [], gene: [], senescent: [] };
const state = {
  running: true,
  ticksPerSecond: Number(speedInput.value),
  actualTicksPerSecond: Number(speedInput.value),
  actualFps: 60,
  lastRenderTs: 0,
  lastPanelTs: 0,
  lastChartTs: 0,
  sharedVersion: -1,
  workerSharedMode: false,
  workerRenderMode: false,
  showCellValues: false,
  showAgingGlow: false,
  polarDayMode: false,
  viewMode: 'eco',
  brushMode: 'life',
  brushShape: 'circle',
  terrainBrushStrength: Number(terrainStrengthInput?.value ?? 0.08),
  activeSidebarTab: 'controls',
  pointerMode: 'none',
  spaceDown: false,
  panStart: null,
  tickSample: { tick: null, ts: null },
  lastRafTs: null
};

const skySync = {
  time: 0,
  ts: performance.now()
};

const camera = {
  zoom: Number(zoomInput.value),
  minZoom: 1,
  maxZoom: 24,
  x: world.width / 2,
  y: world.height / 2
};

function sendToWorker(message, transferables = []) {
  if (ENGINE === 'worker') {
    simWorker.postMessage(message, transferables);
    return;
  }
  // taichi backend mode: proxy via /api/message
  if (!backendReady && message?.type !== 'init') {
    if (message?.type === 'setCanvasSize') pendingTaichiCanvasSize = message;
    else if (message?.type === 'setView') pendingTaichiView = message;
    else if (message?.type === 'applyBrush' || message?.type === 'applyTerrainBrush') pendingTaichiBrushMessage = message;
    return;
  }
  const type = message?.type;
  if (type === 'reset' || type === 'loadPreset' || type === 'undoTerrainEdit' || type === 'redoTerrainEdit') {
    pendingTaichiBrushMessage = null;
  }
  if (type === 'applyBrush' || type === 'applyTerrainBrush') {
    pendingTaichiBrushMessage = message;
    if (!taichiBrushInFlight) void flushTaichiBrushQueue();
    return;
  }
  void postBackendMessage(message);
}

function sampleActualTps(tick, now = performance.now()) {
  if (!Number.isFinite(tick)) return;
  const prevTick = state.tickSample.tick;
  const prevTs = state.tickSample.ts;
  state.tickSample.tick = tick;
  state.tickSample.ts = now;
  if (!Number.isFinite(prevTick) || !Number.isFinite(prevTs)) return;
  const dt = (now - prevTs) / 1000;
  if (dt <= 0.03) return;
  const dTick = tick - prevTick;
  if (!Number.isFinite(dTick) || dTick < 0) return;
  const measured = dTick / dt;
  if (!Number.isFinite(measured)) return;
  state.actualTicksPerSecond = state.actualTicksPerSecond * (1 - ACTUAL_TPS_SMOOTHING) + measured * ACTUAL_TPS_SMOOTHING;
}

function sampleActualFps(now) {
  const prevTs = state.lastRafTs;
  state.lastRafTs = now;
  if (!Number.isFinite(prevTs)) return;
  const dtSec = (now - prevTs) / 1000;
  if (dtSec <= 0) return;
  const fps = 1 / dtSec;
  if (!Number.isFinite(fps)) return;
  state.actualFps = state.actualFps * (1 - ACTUAL_FPS_SMOOTHING) + fps * ACTUAL_FPS_SMOOTHING;
}

function updateSpeedReadout() {
  const actualTps = Number.isFinite(state.actualTicksPerSecond) ? state.actualTicksPerSecond : state.ticksPerSecond;
  const diff = Math.abs(actualTps - state.ticksPerSecond);
  const fps = Number.isFinite(state.actualFps) ? state.actualFps : 0;
  const ticksPerFrame = fps > 0.01 ? (actualTps / fps) : 0;
  const tpsHudText = diff >= 20
    ? `${state.ticksPerSecond.toFixed(1)} tick/s（实际 ${actualTps.toFixed(0)}）`
    : `${state.ticksPerSecond.toFixed(1)} tick/s`;
  speedValue.textContent = `${state.ticksPerSecond.toFixed(1)} tick/s`;
  if (simPerfHud) simPerfHud.textContent = `${tpsHudText} | ${fps.toFixed(1)} FPS | ${ticksPerFrame.toFixed(1)} tick/frame`;
}

function taichiRenderInterval(viewMode, ticksPerSecond) {
  if (viewMode === 'transfer') return TAICHI_TRANSFER_RENDER_INTERVAL_MS;
  if (ticksPerSecond > 1440) return TAICHI_RENDER_INTERVAL_ULTRA_MS;
  if (ticksPerSecond > 960) return TAICHI_RENDER_INTERVAL_TURBO_MS;
  if (ticksPerSecond > 640) return TAICHI_RENDER_INTERVAL_HIGH_MS;
  return TAICHI_RENDER_INTERVAL_MS;
}

function postBackendMessage(message) {
  return fetch('/api/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  })
    .then(async (res) => {
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt}`.trim());
      }
      return res.json().catch(() => null);
    })
    .then((data) => {
      if (!data || typeof data !== 'object') return;
      if (data.terrainHistoryState) {
        const historyState = data.terrainHistoryState;
        if (btnMapUndo) btnMapUndo.disabled = !historyState.canUndo;
        if (btnMapRedo) btnMapRedo.disabled = !historyState.canRedo;
        if (historyState.action === 'undo') panel.hint.textContent = '已撤销地图编辑';
        else if (historyState.action === 'redo') panel.hint.textContent = '已重做地图编辑';
      }
    })
    .catch((error) => {
      console.warn('[backend] message failed', message?.type, error?.message || error);
    });
}

function flushTaichiBrushQueue() {
  if (ENGINE !== 'taichi' || taichiBrushInFlight || !backendReady) return Promise.resolve();
  const next = pendingTaichiBrushMessage;
  if (!next) return Promise.resolve();
  pendingTaichiBrushMessage = null;
  taichiBrushInFlight = true;
  return postBackendMessage(next)
    .finally(() => {
      taichiBrushInFlight = false;
      if (pendingTaichiBrushMessage) void flushTaichiBrushQueue();
    });
}

function pushHistory(stats) {
  history.biomass.push(clamp(stats.normalizedBiomass ?? 0, 0, 1));
  history.gene.push(stats.avgGene);
  history.senescent.push(clamp(stats.senescentRatio ?? 0, 0, 1));
  if (history.biomass.length > HISTORY_MAX) history.biomass.shift();
  if (history.gene.length > HISTORY_MAX) history.gene.shift();
  if (history.senescent.length > HISTORY_MAX) history.senescent.shift();
}

function applySnapshotMeta(snapshotMeta) {
  world.time = snapshotMeta.time;
  if (Number.isFinite(snapshotMeta.day)) world.day = snapshotMeta.day;
  world.sunlight = snapshotMeta.sunlight ?? world.sunlight;
  world.stats.tick = snapshotMeta.stats.tick;
  world.stats.totalBiomass = snapshotMeta.stats.totalBiomass;
  world.stats.avgGene = snapshotMeta.stats.avgGene;
  world.stats.plantCount = snapshotMeta.stats.plantCount;
  world.stats.normalizedBiomass = snapshotMeta.stats.normalizedBiomass ?? world.stats.normalizedBiomass;
  world.stats.senescentRatio = snapshotMeta.stats.senescentRatio ?? world.stats.senescentRatio;
  pushHistory(world.stats);
  sampleActualTps(world.stats.tick);
  skySync.time = world.time;
  skySync.ts = performance.now();
}

function applySnapshot(snapshot) {
  world.front.biomass = new Float32Array(snapshot.biomass);
  world.front.energy = new Float32Array(snapshot.energy);
  world.front.gene = new Float32Array(snapshot.gene);
  world.front.type = new Uint8Array(snapshot.cellType);
  if (snapshot.age) world.front.age = new Float32Array(snapshot.age);
  if (snapshot.flowIn) world.flow.in = new Float32Array(snapshot.flowIn);
  if (snapshot.flowOut) world.flow.out = new Float32Array(snapshot.flowOut);
  if (snapshot.flowVx) world.flow.vx = new Float32Array(snapshot.flowVx);
  if (snapshot.flowVy) world.flow.vy = new Float32Array(snapshot.flowVy);
  if (Number.isFinite(snapshot.day)) world.day = snapshot.day;
  applySnapshotMeta(snapshot);
}

function applySharedSnapshotIfNeeded() {
  if (state.workerRenderMode || !state.workerSharedMode || !sharedChannels) return;
  const version = Atomics.load(sharedChannels.control, CTRL_VERSION);
  if (version === state.sharedVersion) return;
  state.sharedVersion = version;
  const slot = Atomics.load(sharedChannels.control, CTRL_WRITE_SLOT);
  const view = sharedChannels.slots[slot];
  world.front.biomass = view.biomass;
  world.front.energy = view.energy;
  world.front.gene = view.gene;
  world.front.type = view.cellType;
  if (view.flowIn) world.flow.in = view.flowIn;
  if (view.flowOut) world.flow.out = view.flowOut;
  if (view.flowVx) world.flow.vx = view.flowVx;
  if (view.flowVy) world.flow.vy = view.flowVy;
}

if (simWorker) simWorker.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'snapshot') {
    pendingSnapshot = message;
    return;
  }
  if (message.type === 'snapshotMeta') {
    pendingSnapshotMeta = message;
    return;
  }
  if (message.type === 'perf') {
    if (Number.isFinite(message.actualTicksPerSecond)) {
      const m = Number(message.actualTicksPerSecond);
      state.actualTicksPerSecond = state.actualTicksPerSecond * (1 - ACTUAL_TPS_SMOOTHING) + m * ACTUAL_TPS_SMOOTHING;
    }
    console.info(
      `[perf] mode=${message.mode} target=${Number(message.targetTicksPerSecond).toFixed(1)} tick/s ` +
      `actual=${Number(message.actualTicksPerSecond).toFixed(1)} tick/s backlog=${Number(message.backlog).toFixed(1)} ` +
      `loops=${message.loops} steps=${message.steps} window=${Math.round(message.elapsedMs)}ms`
    );
    return;
  }
  if (message.type === 'workerError') {
    console.error('[sim-worker:error]', message.stage, message.message, message.stack || '');
    panel.hint.textContent = `模拟线程异常(${message.stage})，请刷新页面并查看控制台`;
    return;
  }
  if (message.type === 'terrainHistoryState') {
    if (btnMapUndo) btnMapUndo.disabled = !message.canUndo;
    if (btnMapRedo) btnMapRedo.disabled = !message.canRedo;
    if (message.action === 'undo') panel.hint.textContent = '已撤销地图编辑';
    else if (message.action === 'redo') panel.hint.textContent = '已重做地图编辑';
    return;
  }
  if (message.type === 'ready') {
    state.workerRenderMode = message.renderMode === RENDER_MODE_WORKER;
    if (!state.workerRenderMode && !simCtx) {
      panel.hint.textContent = 'OffscreenCanvas 初始化失败，请刷新页面';
      return;
    }
    state.workerSharedMode = !!message.sharedMode;
    if (!state.workerSharedMode && supportsSharedSnapshots) {
      panel.hint.textContent = 'SharedArrayBuffer 不可用，已回退普通快照';
      if (!state.workerRenderMode) return;
    }
    panel.hint.textContent = BASE_HINT;
  }
});

if (simWorker) simWorker.addEventListener('error', (event) => {
  console.error('[sim-worker:event-error]', event.message || 'worker runtime error');
  panel.hint.textContent = '模拟线程异常，请刷新页面';
});

function applyCameraBounds() {
  const halfW = world.width / (2 * camera.zoom);
  const halfH = world.height / (2 * camera.zoom);
  camera.x = clamp(camera.x, halfW, world.width - halfW);
  camera.y = clamp(camera.y, halfH, world.height - halfH);
}

function currentView() {
  const sw = world.width / camera.zoom;
  const sh = world.height / camera.zoom;
  return { sx: camera.x - sw / 2, sy: camera.y - sh / 2, sw, sh };
}

function syncViewToWorker() {
  const view = currentView();
  sendToWorker({
    type: 'setView',
    sx: view.sx,
    sy: view.sy,
    sw: view.sw,
    sh: view.sh,
    zoom: camera.zoom,
    viewMode: state.viewMode,
    showCellValues: state.showCellValues,
    showAgingGlow: state.showAgingGlow
  });
}

function syncReadouts() {
  updateSpeedReadout();
  if (sunSpeedValue && sunSpeedInput) sunSpeedValue.textContent = Number(sunSpeedInput.value).toFixed(3);
  if (sunSpeedInput) sunSpeedInput.disabled = !!state.polarDayMode;
  if (btnPolarDay) {
    btnPolarDay.textContent = state.polarDayMode ? '极昼模式：开' : '极昼模式：关';
    btnPolarDay.classList.toggle('is-active', !!state.polarDayMode);
  }
  zoomValue.textContent = `${camera.zoom.toFixed(1)}x`;
  const radiusText = `${Number(radiusInput.value) | 0}`;
  if (radiusValue) radiusValue.textContent = radiusText;
  if (radiusValueMap) radiusValueMap.textContent = radiusText;
  if (radiusInputMap && radiusInputMap.value !== radiusInput.value) radiusInputMap.value = radiusInput.value;
  if (geneValue) geneValue.textContent = Number(geneInput.value).toFixed(2);
  if (terrainStrengthValue && terrainStrengthInput) terrainStrengthValue.textContent = Number(terrainStrengthInput.value).toFixed(2);
  const enabled = state.showCellValues;
  const zoomReady = camera.zoom >= CELL_VALUES_MIN_ZOOM;
  btnCellValues.textContent = enabled ? (zoomReady ? '格子数值：开' : `格子数值：开（需≥${CELL_VALUES_MIN_ZOOM}x）`) : '格子数值：关';
  btnCellValues.classList.toggle('is-active', enabled);
  if (btnAgingGlow) {
    btnAgingGlow.textContent = state.showAgingGlow ? '衰老预警：开' : '衰老预警：关';
    btnAgingGlow.classList.toggle('is-active', state.showAgingGlow);
  }
}

function setZoom(nextZoom) {
  camera.zoom = clamp(nextZoom, camera.minZoom, camera.maxZoom);
  applyCameraBounds();
  zoomInput.value = camera.zoom.toFixed(1);
  syncReadouts();
  syncViewToWorker();
}

function zoomAt(clientX, clientY, factor) {
  const rect = simCanvas.getBoundingClientRect();
  const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
  const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
  const before = currentView();
  const wx = before.sx + nx * before.sw;
  const wy = before.sy + ny * before.sh;
  setZoom(camera.zoom * factor);
  const after = currentView();
  camera.x += wx - (after.sx + nx * after.sw);
  camera.y += wy - (after.sy + ny * after.sh);
  applyCameraBounds();
  syncReadouts();
  syncViewToWorker();
}

function drawChartIfNeeded(now) {
  if (now - state.lastChartTs >= CHART_MIN_INTERVAL_MS) {
    drawChart(chartCtx, chartCanvas.width, chartCanvas.height, history.biomass, history.gene, history.senescent);
    state.lastChartTs = now;
  }
}

const backendTextDecoder = new TextDecoder();
let backendInFlight = false;
let backendFailures = 0;
let backendRetryAfterTs = 0;
function applyBackendMeta(meta) {
  if (!meta?.sim) return;
  world.time = meta.sim.time ?? world.time;
  world.day = meta.sim.day ?? world.day;
  world.sunlight = meta.sim.sunlight ?? world.sunlight;
  world.stats.tick = meta.sim.tick ?? world.stats.tick;
  if (meta.stats) {
    world.stats.plantCount = meta.stats.plant_count ?? world.stats.plantCount;
    world.stats.totalBiomass = meta.stats.total_biomass ?? world.stats.totalBiomass;
    world.stats.avgGene = meta.stats.avg_gene ?? world.stats.avgGene;
    world.stats.normalizedBiomass = meta.stats.normalized_biomass ?? world.stats.normalizedBiomass;
    world.stats.senescentRatio = meta.stats.senescent_ratio ?? world.stats.senescentRatio;
  }
  pushHistory(world.stats);
  sampleActualTps(world.stats.tick);
  skySync.time = world.time;
  skySync.ts = performance.now();
  // 把“速度读数/暂停状态”跟后端同步一下（避免 UI 漂移）
  if (typeof meta.sim.ticksPerSecond === 'number') state.ticksPerSecond = meta.sim.ticksPerSecond;
  if (typeof meta.sim.running === 'boolean') state.running = meta.sim.running;
}

function requestBackendFrame(now) {
  if (ENGINE !== 'taichi') return;
  if (backendInFlight) return;
  if (now < backendRetryAfterTs) return;
  if (!simCtx || !bufferCtx || !bufferCanvas || !frame) return;
  backendInFlight = true;
  void fetch('/api/frame')
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => {
      const view = new DataView(buf);
      const metaLen = view.getUint32(0, true);
      const metaJson = backendTextDecoder.decode(new Uint8Array(buf, 4, metaLen));
      const meta = JSON.parse(metaJson);
      const rgba = new Uint8ClampedArray(buf, 4 + metaLen);
      if (rgba.length === frame.data.length) frame.data.set(rgba);
      bufferCtx.putImageData(frame, 0, 0);
      simCtx.imageSmoothingEnabled = false;
      simCtx.clearRect(0, 0, simCanvas.width, simCanvas.height);
      simCtx.drawImage(bufferCanvas, 0, 0, bufferCanvas.width, bufferCanvas.height, 0, 0, simCanvas.width, simCanvas.height);
      applyBackendMeta(meta);
      drawChartIfNeeded(now);
      backendFailures = 0;
    })
    .catch((error) => {
      backendFailures++;
      if (backendFailures === 1) console.warn('[backend] frame failed', error?.message || error);
      if (backendFailures === 3) panel.hint.textContent = 'Taichi 后端帧拉取失败（已重试），请检查 Python 后端是否在运行';
      const backoff = Math.min(2000, 120 * (2 ** Math.min(backendFailures, 5)));
      backendRetryAfterTs = now + backoff;
    })
    .finally(() => {
      backendInFlight = false;
    });
}

function paintFrame(now) {
  if (ENGINE === 'taichi') return;
  if (!simCtx || !bufferCtx || !bufferCanvas || !frame) return;
  const view = currentView();
  paintWorldToPixelsView(world, frame.data, view, bufferCanvas.width, bufferCanvas.height, { showAgingGlow: state.showAgingGlow, viewMode: state.viewMode, nowMs: now });
  bufferCtx.putImageData(frame, 0, 0);
  simCtx.imageSmoothingEnabled = false;
  simCtx.clearRect(0, 0, simCanvas.width, simCanvas.height);
  simCtx.drawImage(bufferCanvas, 0, 0, bufferCanvas.width, bufferCanvas.height, 0, 0, simCanvas.width, simCanvas.height);
  if (state.viewMode === 'transfer') {
    drawFlowOverlay(simCtx, world, view, simCanvas.width, simCanvas.height, now);
  }
  if (state.showCellValues && camera.zoom >= CELL_VALUES_MIN_ZOOM) {
    drawCellValuesOverlay(simCtx, world, view, simCanvas.width, simCanvas.height);
  }
  drawChartIfNeeded(now);
}

function refreshPanel() {
  updateSpeedReadout();
  const stats = world.stats;
  const day = Number.isFinite(world.day) ? world.day : 0;
  panel.time.textContent = day.toFixed(2);
  if (panel.sunlight) panel.sunlight.textContent = world.sunlight.toFixed(3);
  panel.biomass.textContent = clamp(stats.normalizedBiomass ?? 0, 0, 1).toFixed(3);
  panel.plants.textContent = `${stats.plantCount}`;
  panel.gene.textContent = stats.avgGene.toFixed(3);
  if (panel.senescent) panel.senescent.textContent = `${(clamp(stats.senescentRatio ?? 0, 0, 1) * 100).toFixed(1)}%`;
}

function resizeCanvases() {
  const area = document.querySelector('.sim-shell').getBoundingClientRect();
  const side = Math.max(360, Math.min(CANVAS_SIDE_DEFAULT, area.width - 32, window.innerHeight * 0.85));
  simTargetWidth = Math.floor(side);
  simTargetHeight = Math.floor(side);
  // After transferControlToOffscreen(), resizing the HTMLCanvasElement buffer is forbidden.
  // Use CSS size for layout, and ask the worker to resize the OffscreenCanvas buffer.
  if (!simOffscreen) {
    simCanvas.width = simTargetWidth;
    simCanvas.height = simTargetHeight;
  }
  simCanvas.style.width = `${simTargetWidth}px`;
  simCanvas.style.height = `${simTargetHeight}px`;

  if (simCtx) {
    if (bufferCanvas && bufferCtx) {
      bufferCanvas.width = simTargetWidth;
      bufferCanvas.height = simTargetHeight;
      frame = bufferCtx.createImageData(simTargetWidth, simTargetHeight);
    }
  }
  chartCanvas.width = 370;
  chartCanvas.height = 240;
  sendToWorker({ type: 'setCanvasSize', width: simTargetWidth, height: simTargetHeight });
  syncViewToWorker();
}

function frameLoop(now) {
  sampleActualFps(now);
  if (ENGINE === 'taichi') {
    const renderInterval = taichiRenderInterval(state.viewMode, state.ticksPerSecond);
    if (now - state.lastRenderTs >= renderInterval) {
      if (backendReady) requestBackendFrame(now);
      state.lastRenderTs = now;
    }
    if (now - state.lastPanelTs >= PANEL_MIN_INTERVAL_MS) {
      refreshPanel();
      state.lastPanelTs = now;
    }

    const dtMs = now - skySync.ts;
    const dtSec = dtMs > 0 ? dtMs / 1000 : 0;
    const effectiveTps = state.running ? (Number.isFinite(state.actualTicksPerSecond) ? state.actualTicksPerSecond : state.ticksPerSecond) : 0;
    const timeRate = effectiveTps * (world.config.timeStep || 0.05);
    const animTime = skySync.time + dtSec * timeRate;
    updateSkyBadge(skyOrbit, animTime, world.config.sunSpeed, { polarDay: state.polarDayMode });

    requestAnimationFrame(frameLoop);
    return;
  }

  if (pendingSnapshotMeta) {
    applySnapshotMeta(pendingSnapshotMeta);
    pendingSnapshotMeta = null;
  }
  applySharedSnapshotIfNeeded();
  if (pendingSnapshot) {
    applySnapshot(pendingSnapshot);
    pendingSnapshot = null;
  }
  const renderInterval = state.viewMode === 'transfer' ? TRANSFER_RENDER_INTERVAL_MS : RENDER_INTERVAL_MS;
  if (now - state.lastRenderTs >= renderInterval) {
    if (state.workerRenderMode) drawChartIfNeeded(now);
    else paintFrame(now);
    state.lastRenderTs = now;
  }
  if (now - state.lastPanelTs >= PANEL_MIN_INTERVAL_MS) {
    refreshPanel();
    state.lastPanelTs = now;
  }

  const dtMs = now - skySync.ts;
  const dtSec = dtMs > 0 ? dtMs / 1000 : 0;
  const effectiveTps = state.running ? (Number.isFinite(state.actualTicksPerSecond) ? state.actualTicksPerSecond : state.ticksPerSecond) : 0;
  const timeRate = effectiveTps * (world.config.timeStep || 0.05);
  const animTime = skySync.time + dtSec * timeRate;
  updateSkyBadge(skyOrbit, animTime, world.config.sunSpeed, { polarDay: state.polarDayMode });

  requestAnimationFrame(frameLoop);
}

bindInteractions({
  simCanvas,
  panel,
  baseHint: BASE_HINT,
  cellValuesMinZoom: CELL_VALUES_MIN_ZOOM,
  state,
  camera,
  world,
  buttons,
  inputs: { speedInput, radiusInput, radiusInputMap, geneInput, sunSpeedInput, zoomInput, terrainStrengthInput },
  sendToWorker,
  setZoom,
  zoomAt,
  currentView,
  applyCameraBounds,
  syncViewToWorker,
  syncReadouts,
  onResetState: () => {
    history.biomass.length = 0;
    history.gene.length = 0;
    history.senescent.length = 0;
    pendingSnapshot = null;
    pendingSnapshotMeta = null;
    state.sharedVersion = -1;
    state.actualTicksPerSecond = state.ticksPerSecond;
    state.actualFps = 60;
    state.tickSample.tick = null;
    state.tickSample.ts = null;
    state.lastRafTs = null;
  },
  onResize: resizeCanvases
});

const sidebarTabs = bindSidebarTabs({
  state,
  tabs,
  onStatsVisible: () => drawChartIfNeeded(performance.now() + CHART_MIN_INTERVAL_MS + 1),
  onControlsTabEnter: () => {
    if (state.viewMode !== 'eco' && btnViewEco) btnViewEco.click();
  },
  onMapTabEnter: () => {
    if (state.viewMode === 'eco' && btnViewTerrainMix) btnViewTerrainMix.click();
  }
});

resizeCanvases();
sidebarTabs.updateTabs();
applyCameraBounds();
panel.hint.textContent = ENGINE === 'taichi' ? '连接 Taichi 后端中...' : '连接模拟线程中...';
world.config.sunSpeed = Number(sunSpeedInput.value);
world.config.polarDay = false;
syncReadouts();
orbit.classList.add('ready');

const initMessage = ENGINE === 'taichi'
  ? {
      type: 'init',
      width: GRID_W,
      height: GRID_H,
      seedCount: 180,
      ticksPerSecond: state.ticksPerSecond,
      sunSpeed: world.config.sunSpeed,
      polarDay: state.polarDayMode,
      running: state.running,
      canvasWidth: simTargetWidth,
      canvasHeight: simTargetHeight
    }
  : {
      type: 'init',
      width: GRID_W,
      height: GRID_H,
      seedCount: 180,
      ticksPerSecond: state.ticksPerSecond,
      sunSpeed: world.config.sunSpeed,
      polarDay: state.polarDayMode,
      running: state.running,
      shared: sharedChannels ? sharedChannels.buffers : null,
      offscreen: simOffscreen ? { canvas: simOffscreen, width: simTargetWidth, height: simTargetHeight } : null
    };

async function initBackendIfNeeded() {
  if (ENGINE !== 'taichi') return;
  try {
    const res = await fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initMessage)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    backendReady = true;
    panel.hint.textContent = 'Taichi 后端初始化完成（fast tick + 后端渲染）。';
    console.info('[backend] ready', data);
    if (data?.terrainHistoryState) {
      if (btnMapUndo) btnMapUndo.disabled = !data.terrainHistoryState.canUndo;
      if (btnMapRedo) btnMapRedo.disabled = !data.terrainHistoryState.canRedo;
    }
    if (pendingTaichiCanvasSize) sendToWorker(pendingTaichiCanvasSize);
    if (pendingTaichiView) sendToWorker(pendingTaichiView);
    if (pendingTaichiBrushMessage) void flushTaichiBrushQueue();
    pendingTaichiCanvasSize = null;
    pendingTaichiView = null;
  } catch (error) {
    backendReady = false;
    console.warn('[backend] init failed', error?.message || error);
    panel.hint.textContent = 'Taichi 后端初始化失败：请查看控制台与后端日志（将继续重试/或切换 ?engine=js）。';
  }
}

if (ENGINE === 'worker') sendToWorker(initMessage, simOffscreen ? [simOffscreen] : []);
else void initBackendIfNeeded();

syncViewToWorker();
frameLoop(performance.now());
