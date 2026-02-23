import { createWorld } from './sim/index.js';
import { drawCellValuesOverlay, drawChart, paintWorldToPixels, updateSkyBadge } from './render.js';
import { bindInteractions } from './main-interactions.js';
import { createSharedChannels } from './main-shared-channels.js';
import { getMainDom } from './main-dom.js';
import { bindSidebarTabs } from './main-tabs.js';

const GRID_W = 240;
const GRID_H = 240;
const HISTORY_MAX = 600;
const BASE_HINT = '当前模式：播种。左键拖动绘制；滚轮缩放；中键拖动平移。';
const CELL_VALUES_MIN_ZOOM = 8;
const PANEL_MIN_INTERVAL_MS = 80;
const CHART_MIN_INTERVAL_MS = 96;
const RENDER_INTERVAL_MS = 15;
const CTRL_WRITE_SLOT = 0;
const CTRL_VERSION = 1;
const RENDER_MODE_WORKER = 'worker';

const world = createWorld(GRID_W, GRID_H);
const simWorker = new Worker(new URL('./workers/sim-worker/index.js', import.meta.url), { type: 'module' });
let pendingSnapshot = null;
let pendingSnapshotMeta = null;

const supportsSharedSnapshots = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
const supportsOffscreenWorker = typeof OffscreenCanvas !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';

const dom = getMainDom();
const { simCanvas, chartCanvas, skyOrbit, orbit, panel, buttons, inputs, tabs } = dom;

const {
  btnPause, btnReset, btnSeed, btnViewReset, btnCellValues, btnAgingGlow,
  btnModeLife, btnModeDisturb, btnModeAnnihilate, btnModeWall, btnModeErase,
  btnModeLightUp, btnModeLightDown, btnModeLossUp, btnModeLossDown,
  btnShapeCircle, btnShapeSquare, btnShapeRect, btnShapeTriangle,
  btnPresetEmpty, btnPresetFourRooms, btnPresetMaze,
  btnPresetFiveZones, btnPresetHourglass, btnPresetRings,
  btnViewEco, btnViewTerrainLight, btnViewTerrainLoss, btnViewTerrainMix,
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

let simTargetWidth = 940;
let simTargetHeight = 940;
const sharedChannels = supportsSharedSnapshots && !simOffscreen ? createSharedChannels(world.size) : null;
const chartCtx = chartCanvas.getContext('2d', { alpha: true });

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

let bufferCanvas = null;
let bufferCtx = null;
let frame = null;
if (simCtx) {
  bufferCanvas = document.createElement('canvas');
  bufferCanvas.width = GRID_W;
  bufferCanvas.height = GRID_H;
  bufferCtx = bufferCanvas.getContext('2d', { alpha: false });
  frame = bufferCtx.createImageData(GRID_W, GRID_H);
}

const history = { biomass: [], gene: [] };
const state = {
  running: true,
  ticksPerSecond: Number(speedInput.value),
  lastRenderTs: 0,
  lastPanelTs: 0,
  lastChartTs: 0,
  sharedVersion: -1,
  workerSharedMode: false,
  workerRenderMode: false,
  showCellValues: false,
  showAgingGlow: false,
  viewMode: 'eco',
  brushMode: 'life',
  brushShape: 'circle',
  terrainBrushStrength: Number(terrainStrengthInput?.value ?? 0.08),
  activeSidebarTab: 'controls',
  pointerMode: 'none',
  spaceDown: false,
  panStart: null
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
  simWorker.postMessage(message, transferables);
}

function pushHistory(stats) {
  history.biomass.push(Math.min(1, stats.totalBiomass / world.size));
  history.gene.push(stats.avgGene);
  if (history.biomass.length > HISTORY_MAX) history.biomass.shift();
  if (history.gene.length > HISTORY_MAX) history.gene.shift();
}

function applySnapshotMeta(snapshotMeta) {
  world.time = snapshotMeta.time;
  if (Number.isFinite(snapshotMeta.day)) world.day = snapshotMeta.day;
  world.sunlight = snapshotMeta.sunlight ?? world.sunlight;
  world.stats.tick = snapshotMeta.stats.tick;
  world.stats.totalBiomass = snapshotMeta.stats.totalBiomass;
  world.stats.avgGene = snapshotMeta.stats.avgGene;
  world.stats.plantCount = snapshotMeta.stats.plantCount;
  pushHistory(world.stats);
  skySync.time = world.time;
  skySync.ts = performance.now();
}

function applySnapshot(snapshot) {
  world.front.biomass = new Float32Array(snapshot.biomass);
  world.front.energy = new Float32Array(snapshot.energy);
  world.front.gene = new Float32Array(snapshot.gene);
  world.front.type = new Uint8Array(snapshot.cellType);
  if (snapshot.age) world.front.age = new Float32Array(snapshot.age);
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
}

simWorker.addEventListener('message', (event) => {
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

simWorker.addEventListener('error', (event) => {
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
  speedValue.textContent = `${state.ticksPerSecond.toFixed(1)} tick/s`;
  if (sunSpeedValue && sunSpeedInput) sunSpeedValue.textContent = Number(sunSpeedInput.value).toFixed(3);
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
    drawChart(chartCtx, chartCanvas.width, chartCanvas.height, history.biomass, history.gene);
    state.lastChartTs = now;
  }
}

function paintFrame(now) {
  if (!simCtx || !bufferCtx || !bufferCanvas || !frame) return;
  paintWorldToPixels(world, frame.data, { showAgingGlow: state.showAgingGlow, viewMode: state.viewMode });
  bufferCtx.putImageData(frame, 0, 0);
  const view = currentView();
  simCtx.imageSmoothingEnabled = false;
  simCtx.clearRect(0, 0, simCanvas.width, simCanvas.height);
  simCtx.drawImage(bufferCanvas, view.sx, view.sy, view.sw, view.sh, 0, 0, simCanvas.width, simCanvas.height);
  if (state.showCellValues && camera.zoom >= CELL_VALUES_MIN_ZOOM) {
    drawCellValuesOverlay(simCtx, world, view, simCanvas.width, simCanvas.height);
  }
  drawChartIfNeeded(now);
}

function refreshPanel() {
  const stats = world.stats;
  const day = Number.isFinite(world.day) ? world.day : (world.time * (world.config.sunSpeed || 0)) / (Math.PI * 2);
  panel.time.textContent = day.toFixed(2);
  if (panel.sunlight) panel.sunlight.textContent = world.sunlight.toFixed(3);
  panel.biomass.textContent = (stats.totalBiomass / world.size).toFixed(3);
  panel.plants.textContent = `${stats.plantCount}`;
  panel.gene.textContent = stats.avgGene.toFixed(3);
}

function resizeCanvases() {
  const area = document.querySelector('.sim-shell').getBoundingClientRect();
  const side = Math.max(360, Math.min(area.width - 32, window.innerHeight * 0.85));
  simTargetWidth = Math.floor(side);
  simTargetHeight = Math.floor(side);
  if (simCtx) {
    simCanvas.width = simTargetWidth;
    simCanvas.height = simTargetHeight;
  }
  chartCanvas.width = 370;
  chartCanvas.height = 240;
  sendToWorker({ type: 'setCanvasSize', width: simTargetWidth, height: simTargetHeight });
  syncViewToWorker();
}

function frameLoop(now) {
  if (pendingSnapshotMeta) {
    applySnapshotMeta(pendingSnapshotMeta);
    pendingSnapshotMeta = null;
  }
  applySharedSnapshotIfNeeded();
  if (pendingSnapshot) {
    applySnapshot(pendingSnapshot);
    pendingSnapshot = null;
  }
  if (now - state.lastRenderTs >= RENDER_INTERVAL_MS) {
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
  const timeRate = state.running ? (state.ticksPerSecond * (world.config.timeStep || 0.05)) : 0;
  const animTime = skySync.time + dtSec * timeRate;
  updateSkyBadge(skyOrbit, animTime, world.config.sunSpeed);

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
    pendingSnapshot = null;
    pendingSnapshotMeta = null;
    state.sharedVersion = -1;
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
panel.hint.textContent = '连接模拟线程中...';
world.config.sunSpeed = Number(sunSpeedInput.value);
syncReadouts();
orbit.classList.add('ready');

const initMessage = {
  type: 'init',
  width: GRID_W,
  height: GRID_H,
  seedCount: 180,
  ticksPerSecond: state.ticksPerSecond,
  sunSpeed: world.config.sunSpeed,
  running: state.running,
  shared: sharedChannels ? sharedChannels.buffers : null,
  offscreen: simOffscreen ? { canvas: simOffscreen, width: simTargetWidth, height: simTargetHeight } : null
};
sendToWorker(initMessage, simOffscreen ? [simOffscreen] : []);
syncViewToWorker();
frameLoop(performance.now());
