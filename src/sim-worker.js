import { applyBrush, computeStats, createWorld, randomSeed, resetWorld, tick, loadPreset } from './sim/index.js';
import { drawCellValuesOverlay, paintWorldToPixels } from './render.js';

const CTRL_WRITE_SLOT = 0;
const CTRL_VERSION = 1;
const CELL_VALUES_MIN_ZOOM = 8;
const RENDER_INTERVAL_MS = 15;
const SIM_BUDGET_PER_LOOP_MS = 14;

const state = {
  world: null,
  running: true,
  ticksPerSecond: 300,
  accumulator: 0,
  lastTs: performance.now(),
  lastSnapshotTs: 0,
  snapshotIntervalMs: 15,
  maxAccumulatorSteps: 256,
  maxStepsPerLoop: 128,
  useShared: false,
  shared: null,
  perf: {
    lastReportTs: performance.now(),
    loops: 0,
    steps: 0
  },
  render: {
    mode: 'none',
    canvas: null,
    ctx: null,
    bufferCanvas: null,
    bufferCtx: null,
    frame: null,
    width: 0,
    height: 0,
    view: null,
    zoom: 1,
    showCellValues: false,
    lastRenderTs: 0
  },
  fatalReported: false,
  showAgingGlow: false
};

const clampSpeed = (v) => Math.max(0.2, Math.min(480, v));

function updateSnapshotInterval() {
  // Worker 渲染时画面不依赖快照，降低统计频率可减少主循环抖动。
  state.snapshotIntervalMs = state.render.mode === 'worker' ? 80 : 15;
}

function applyView(sx, sy, sw, sh, zoom, showCellValues) {
  const world = state.world;
  if (!world) return;
  const safeSw = Number.isFinite(sw) && sw > 0 ? sw : world.width;
  const safeSh = Number.isFinite(sh) && sh > 0 ? sh : world.height;
  const next = {
    sx: Number.isFinite(sx) ? sx : 0,
    sy: Number.isFinite(sy) ? sy : 0,
    sw: safeSw,
    sh: safeSh
  };
  state.render.view = next;
  state.render.zoom = Number.isFinite(zoom) ? zoom : state.render.zoom;
  if (typeof showCellValues === 'boolean') state.render.showCellValues = showCellValues;
}

function initRenderer(offscreenSpec, width, height) {
  if (!offscreenSpec || !offscreenSpec.canvas) return false;
  const canvas = offscreenSpec.canvas;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return false;
  canvas.width = Number(width) || canvas.width;
  canvas.height = Number(height) || canvas.height;
  const bufferCanvas = new OffscreenCanvas(state.world.width, state.world.height);
  const bufferCtx = bufferCanvas.getContext('2d', { alpha: false });
  if (!bufferCtx) return false;
  const frame = bufferCtx.createImageData(state.world.width, state.world.height);
  state.render.mode = 'worker';
  state.render.canvas = canvas;
  state.render.ctx = ctx;
  state.render.bufferCanvas = bufferCanvas;
  state.render.bufferCtx = bufferCtx;
  state.render.frame = frame;
  state.render.width = canvas.width;
  state.render.height = canvas.height;
  state.render.lastRenderTs = 0;
  return true;
}

function setCanvasSize(width, height) {
  if (state.render.mode !== 'worker' || !state.render.canvas) return;
  const w = Math.max(1, Number(width) || state.render.canvas.width);
  const h = Math.max(1, Number(height) || state.render.canvas.height);
  state.render.canvas.width = w;
  state.render.canvas.height = h;
  state.render.width = w;
  state.render.height = h;
}

function reportWorkerError(stage, error) {
  if (state.fatalReported) return;
  state.fatalReported = true;
  self.postMessage({
    type: 'workerError',
    stage,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : ''
  });
}

function renderFrame(force = false) {
  if (state.render.mode !== 'worker' || !state.world) return;
  try {
    const now = performance.now();
    if (!force && now - state.render.lastRenderTs < RENDER_INTERVAL_MS) return;
    state.render.lastRenderTs = now;

    const { world, render } = state;
    const view = render.view || { sx: 0, sy: 0, sw: world.width, sh: world.height };
    paintWorldToPixels(world, render.frame.data, { showAgingGlow: state.showAgingGlow });
    render.bufferCtx.putImageData(render.frame, 0, 0);
    render.ctx.imageSmoothingEnabled = false;
    render.ctx.clearRect(0, 0, render.width, render.height);
    render.ctx.drawImage(render.bufferCanvas, view.sx, view.sy, view.sw, view.sh, 0, 0, render.width, render.height);
    if (render.showCellValues && render.zoom >= CELL_VALUES_MIN_ZOOM) {
      drawCellValuesOverlay(render.ctx, world, view, render.width, render.height);
    }
  } catch (error) {
    reportWorkerError('renderFrame', error);
  }
}

function publishSharedSnapshot(force = false) {
  const world = state.world;
  const shared = state.shared;
  if (!world || !shared) return;
  const now = performance.now();
  if (!force && now - state.lastSnapshotTs < state.snapshotIntervalMs) return;
  state.lastSnapshotTs = now;
  const stats = computeStats(world);
  const currentSlot = Atomics.load(shared.control, CTRL_WRITE_SLOT);
  const nextSlot = currentSlot ^ 1;
  const slot = shared.slots[nextSlot];
  slot.biomass.set(world.front.biomass);
  slot.energy.set(world.front.energy);
  slot.gene.set(world.front.gene);
  slot.cellType.set(world.front.type);
  Atomics.store(shared.control, CTRL_WRITE_SLOT, nextSlot);
  const version = Atomics.add(shared.control, CTRL_VERSION, 1) + 1;
  self.postMessage({
    type: 'snapshotMeta',
    version,
    time: world.time,
    sunlight: world.sunlight,
    stats: {
      tick: stats.tick,
      totalBiomass: stats.totalBiomass,
      avgGene: stats.avgGene,
      plantCount: stats.plantCount
    }
  });
}

function publishTransferSnapshot(force = false) {
  const world = state.world;
  if (!world) return;
  const now = performance.now();
  if (!force && now - state.lastSnapshotTs < state.snapshotIntervalMs) return;
  state.lastSnapshotTs = now;
  const stats = computeStats(world);
  const biomass = world.front.biomass.slice();
  const energy = world.front.energy.slice();
  const gene = world.front.gene.slice();
  const age = world.front.age.slice();
  const cellType = world.front.type.slice();
  self.postMessage({
    type: 'snapshot',
    time: world.time,
    sunlight: world.sunlight,
    stats: {
      tick: stats.tick,
      totalBiomass: stats.totalBiomass,
      avgGene: stats.avgGene,
      plantCount: stats.plantCount
    },
    biomass: biomass.buffer,
    energy: energy.buffer,
    gene: gene.buffer,
    age: age.buffer,
    cellType: cellType.buffer
  }, [biomass.buffer, energy.buffer, gene.buffer, age.buffer, cellType.buffer]);
}

function publishMetaOnly(force = false) {
  const world = state.world;
  if (!world) return;
  const now = performance.now();
  if (!force && now - state.lastSnapshotTs < state.snapshotIntervalMs) return;
  state.lastSnapshotTs = now;
  const stats = computeStats(world);
  self.postMessage({
    type: 'snapshotMeta',
    time: world.time,
    sunlight: world.sunlight,
    stats: {
      tick: stats.tick,
      totalBiomass: stats.totalBiomass,
      avgGene: stats.avgGene,
      plantCount: stats.plantCount
    }
  });
}

function postSnapshot(force = false) {
  if (state.useShared) publishSharedSnapshot(force);
  else if (state.render.mode === 'worker') publishMetaOnly(force);
  else publishTransferSnapshot(force);
}

function initSharedChannels(sharedSpec, size) {
  if (!sharedSpec) return false;
  if (typeof SharedArrayBuffer === 'undefined') return false;
  const control = new Int32Array(sharedSpec.control);
  const biomassAll = new Float32Array(sharedSpec.biomass);
  const energyAll = new Float32Array(sharedSpec.energy);
  const geneAll = new Float32Array(sharedSpec.gene);
  const typeAll = new Uint8Array(sharedSpec.cellType);
  const offset = size;
  state.shared = {
    control,
    slots: [
      {
        biomass: biomassAll.subarray(0, offset),
        energy: energyAll.subarray(0, offset),
        gene: geneAll.subarray(0, offset),
        cellType: typeAll.subarray(0, offset)
      },
      {
        biomass: biomassAll.subarray(offset, offset * 2),
        energy: energyAll.subarray(offset, offset * 2),
        gene: geneAll.subarray(offset, offset * 2),
        cellType: typeAll.subarray(offset, offset * 2)
      }
    ]
  };
  Atomics.store(control, CTRL_WRITE_SLOT, 0);
  Atomics.store(control, CTRL_VERSION, 0);
  state.useShared = true;
  return true;
}

function step() {
  try {
    const world = state.world;
    if (!world) return;
    const now = performance.now();
    const dt = Math.min(0.25, (now - state.lastTs) / 1000 || 0);
    state.lastTs = now;
    const loopStart = now;
    let steps = 0;

    if (state.running) {
      state.accumulator = Math.min(state.maxAccumulatorSteps, state.accumulator + dt * state.ticksPerSecond);
      while (state.accumulator >= 1 && steps < state.maxStepsPerLoop) {
        tick(world);
        state.accumulator -= 1;
        steps++;
        if ((steps & 7) === 0 && performance.now() - loopStart >= SIM_BUDGET_PER_LOOP_MS) break;
      }
      if (steps > 0) {
        postSnapshot(false);
        renderFrame(false);
      } else if (state.render.mode === 'worker') {
        renderFrame(false);
      }
    } else if (now - state.lastSnapshotTs >= 250) {
      postSnapshot(false);
      renderFrame(false);
    } else if (state.render.mode === 'worker') {
      renderFrame(false);
    }

    const perf = state.perf;
    perf.loops++;
    perf.steps += steps;
    const elapsedMs = now - perf.lastReportTs;
    if (elapsedMs >= 5000) {
      const actualTicksPerSecond = elapsedMs > 0 ? (perf.steps * 1000) / elapsedMs : 0;
      self.postMessage({
        type: 'perf',
        mode: state.render.mode,
        targetTicksPerSecond: state.ticksPerSecond,
        actualTicksPerSecond,
        backlog: state.accumulator,
        loops: perf.loops,
        steps: perf.steps,
        elapsedMs
      });
      perf.lastReportTs = now;
      perf.loops = 0;
      perf.steps = 0;
    }
  } catch (error) {
    reportWorkerError('step', error);
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;

  switch (message.type) {
    case 'init': {
      const width = Number(message.width) || 180;
      const height = Number(message.height) || 180;
      state.world = createWorld(width, height);
      state.world.config.sunSpeed = Number(message.sunSpeed) || state.world.config.sunSpeed;
      state.ticksPerSecond = clampSpeed(Number(message.ticksPerSecond) || state.ticksPerSecond);
      state.running = message.running !== false;
      state.accumulator = 0;
      state.lastTs = performance.now();
      state.fatalReported = false;
      state.useShared = false;
      state.shared = null;
      state.perf.lastReportTs = performance.now();
      state.perf.loops = 0;
      state.perf.steps = 0;
      initSharedChannels(message.shared, state.world.size);
      initRenderer(message.offscreen, message.offscreen?.width, message.offscreen?.height);
      updateSnapshotInterval();
      applyView(0, 0, state.world.width, state.world.height, 1, false);
      const seedCount = Number(message.seedCount) || 0;
      if (seedCount > 0) randomSeed(state.world, seedCount);
      postSnapshot(true);
      renderFrame(true);
      self.postMessage({ type: 'ready', sharedMode: state.useShared, renderMode: state.render.mode });
      return;
    }
    case 'setRunning': {
      state.running = !!message.running;
      state.lastTs = performance.now();
      return;
    }
    case 'setTicksPerSecond': {
      state.ticksPerSecond = clampSpeed(Number(message.value) || state.ticksPerSecond);
      updateSnapshotInterval();
      return;
    }
    case 'setSunSpeed': {
      if (!state.world) return;
      state.world.config.sunSpeed = Number(message.value) || state.world.config.sunSpeed;
      return;
    }
    case 'setView': {
      if (!state.world) return;
      applyView(message.sx, message.sy, message.sw, message.sh, message.zoom, message.showCellValues);
      if (typeof message.showAgingGlow === 'boolean') state.showAgingGlow = message.showAgingGlow;
      renderFrame(true);
      return;
    }
    case 'setShowAgingGlow': {
      state.showAgingGlow = !!message.value;
      renderFrame(true);
      return;
    }
    case 'setCanvasSize': {
      setCanvasSize(message.width, message.height);
      renderFrame(true);
      return;
    }
    case 'applyBrush': {
      if (!state.world) return;
      applyBrush(state.world, Number(message.cx), Number(message.cy), Number(message.radius), message.mode, message.options || {});
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    case 'reset': {
      if (!state.world) return;
      resetWorld(state.world);
      state.accumulator = 0;
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    case 'loadPreset': {
      if (!state.world) return;
      loadPreset(state.world, message.presetName);
      state.accumulator = 0;
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    case 'randomSeed': {
      if (!state.world) return;
      randomSeed(state.world, Number(message.count) || 160);
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    default:
      return;
  }
};

setInterval(step, 8);
