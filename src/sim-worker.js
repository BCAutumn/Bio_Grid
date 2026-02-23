import { applyBrush, computeStats, createWorld, randomSeed, resetWorld, tick, loadPreset } from './sim/index.js';
import { drawCellValuesOverlay, paintWorldToPixels } from './render.js';

const CTRL_WRITE_SLOT = 0;
const CTRL_VERSION = 1;
const CELL_VALUES_MIN_ZOOM = 8;
const RENDER_INTERVAL_MS = 33;
const SIM_BUDGET_PER_LOOP_MS = 24;

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
    viewMode: 'eco',
    showCellValues: false,
    lastRenderTs: 0
  },
  fatalReported: false,
  showAgingGlow: false,
  terrainHistory: {
    undo: [],
    redo: [],
    limit: 30
  }
};

const clampSpeed = (v) => Math.max(0.2, Math.min(480, v));
const clampSunSpeed = (v) => Math.max(0.004, Math.min(0.12, v));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function inBrushShape(dx, dy, r, shape) {
  if (shape === 'square') return Math.abs(dx) <= r && Math.abs(dy) <= r;
  if (shape === 'rect') return Math.abs(dx) <= r && Math.abs(dy) <= r * 0.5;
  if (shape === 'triangle') {
    if (dy < -r || dy > r * 0.5) return false;
    const halfWidthAtY = r * (1 - (dy + r) / (1.5 * r));
    return Math.abs(dx) <= halfWidthAtY && halfWidthAtY > 0;
  }
  return dx * dx + dy * dy <= r * r;
}

function applyTerrainBrush(world, cx, cy, radius, shape, channel, delta) {
  const terrain = world.terrain;
  if (!terrain) return;
  const target = channel === 'loss' ? terrain.loss : terrain.light;
  const min = channel === 'loss' ? terrain.lossMin : terrain.lightMin;
  const max = channel === 'loss' ? terrain.lossMax : terrain.lightMax;
  const r = Math.max(1, Number(radius) || 1);
  const sx = Math.max(0, Math.floor(cx - r));
  const ex = Math.min(world.width - 1, Math.ceil(cx + r));
  const sy = Math.max(0, Math.floor(cy - r));
  const ey = Math.min(world.height - 1, Math.ceil(cy + r));
  const amount = Number(delta) || 0;
  if (!amount) return;

  for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
    const dx = x - cx;
    const dy = y - cy;
    if (!inBrushShape(dx, dy, r, shape)) continue;
    const i = y * world.width + x;
    target[i] = clamp(target[i] + amount, min, max);
  }
}

function resetTerrainUniform(world) {
  if (!world?.terrain) return;
  world.terrain.light.fill(1);
  world.terrain.loss.fill(1);
}

function updateSnapshotInterval() {
  // Worker 渲染时画面不依赖快照，降低统计频率可减少主循环抖动。
  state.snapshotIntervalMs = state.render.mode === 'worker' ? 80 : 15;
}

function applyView(sx, sy, sw, sh, zoom, showCellValues, viewMode) {
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
  if (typeof viewMode === 'string') state.render.viewMode = viewMode;
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

function cloneWorldState(world) {
  return {
    front: {
      biomass: world.front.biomass.slice(),
      energy: world.front.energy.slice(),
      gene: world.front.gene.slice(),
      age: world.front.age.slice(),
      type: world.front.type.slice()
    },
    back: {
      biomass: world.back.biomass.slice(),
      energy: world.back.energy.slice(),
      gene: world.back.gene.slice(),
      age: world.back.age.slice(),
      type: world.back.type.slice()
    },
    time: world.time,
    sunlight: world.sunlight,
    stats: { ...world.stats },
    wallCount: world.wallCount
  };
}

function restoreWorldState(world, snapshot) {
  if (!world || !snapshot) return;
  world.front.biomass.set(snapshot.front.biomass);
  world.front.energy.set(snapshot.front.energy);
  world.front.gene.set(snapshot.front.gene);
  world.front.age.set(snapshot.front.age);
  world.front.type.set(snapshot.front.type);
  world.back.biomass.set(snapshot.back.biomass);
  world.back.energy.set(snapshot.back.energy);
  world.back.gene.set(snapshot.back.gene);
  world.back.age.set(snapshot.back.age);
  world.back.type.set(snapshot.back.type);
  world.time = snapshot.time;
  world.sunlight = snapshot.sunlight;
  world.stats.tick = snapshot.stats.tick;
  world.stats.totalBiomass = snapshot.stats.totalBiomass;
  world.stats.avgGene = snapshot.stats.avgGene;
  world.stats.plantCount = snapshot.stats.plantCount;
  world.wallCount = snapshot.wallCount;
}

function postTerrainHistoryState(action = 'sync') {
  self.postMessage({
    type: 'terrainHistoryState',
    action,
    canUndo: state.terrainHistory.undo.length > 0,
    canRedo: state.terrainHistory.redo.length > 0
  });
}

function pushTerrainHistory(clearRedo = true) {
  if (!state.world) return;
  const { undo, redo, limit } = state.terrainHistory;
  undo.push(cloneWorldState(state.world));
  if (undo.length > limit) undo.shift();
  if (clearRedo) redo.length = 0;
  postTerrainHistoryState('push');
}

function undoTerrainEdit() {
  if (!state.world) return;
  const { undo, redo } = state.terrainHistory;
  if (!undo.length) {
    postTerrainHistoryState('undo-empty');
    return;
  }
  const current = cloneWorldState(state.world);
  const prev = undo.pop();
  redo.push(current);
  restoreWorldState(state.world, prev);
  state.accumulator = 0;
  postSnapshot(true);
  renderFrame(true);
  postTerrainHistoryState('undo');
}

function redoTerrainEdit() {
  if (!state.world) return;
  const { undo, redo } = state.terrainHistory;
  if (!redo.length) {
    postTerrainHistoryState('redo-empty');
    return;
  }
  const current = cloneWorldState(state.world);
  const next = redo.pop();
  undo.push(current);
  restoreWorldState(state.world, next);
  state.accumulator = 0;
  postSnapshot(true);
  renderFrame(true);
  postTerrainHistoryState('redo');
}

function renderFrame(force = false) {
  if (state.render.mode !== 'worker' || !state.world) return;
  try {
    const now = performance.now();
    if (!force && now - state.render.lastRenderTs < RENDER_INTERVAL_MS) return;
    state.render.lastRenderTs = now;

    const { world, render } = state;
    const view = render.view || { sx: 0, sy: 0, sw: world.width, sh: world.height };
    paintWorldToPixels(world, render.frame.data, { showAgingGlow: state.showAgingGlow, viewMode: render.viewMode });
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
  const day = (world.time * (world.config.sunSpeed || 0)) / (Math.PI * 2);
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
    day,
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
  const day = (world.time * (world.config.sunSpeed || 0)) / (Math.PI * 2);
  const biomass = world.front.biomass.slice();
  const energy = world.front.energy.slice();
  const gene = world.front.gene.slice();
  const age = world.front.age.slice();
  const cellType = world.front.type.slice();
  self.postMessage({
    type: 'snapshot',
    time: world.time,
    day,
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
  const day = (world.time * (world.config.sunSpeed || 0)) / (Math.PI * 2);
  self.postMessage({
    type: 'snapshotMeta',
    time: world.time,
    day,
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
      state.world.config.sunSpeed = clampSunSpeed(Number(message.sunSpeed) || state.world.config.sunSpeed);
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
      state.terrainHistory.undo.length = 0;
      state.terrainHistory.redo.length = 0;
      initSharedChannels(message.shared, state.world.size);
      initRenderer(message.offscreen, message.offscreen?.width, message.offscreen?.height);
      updateSnapshotInterval();
      applyView(0, 0, state.world.width, state.world.height, 1, false, 'eco');
      const seedCount = Number(message.seedCount) || 0;
      if (seedCount > 0) randomSeed(state.world, seedCount);
      postSnapshot(true);
      renderFrame(true);
      postTerrainHistoryState('init');
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
      const raw = Number(message.value);
      if (!Number.isFinite(raw)) return;
      state.world.config.sunSpeed = clampSunSpeed(raw);
      return;
    }
    case 'setView': {
      if (!state.world) return;
      applyView(message.sx, message.sy, message.sw, message.sh, message.zoom, message.showCellValues, message.viewMode);
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
    case 'applyTerrainBrush': {
      if (!state.world) return;
      applyTerrainBrush(
        state.world,
        Number(message.cx),
        Number(message.cy),
        Number(message.radius),
        message.shape || 'circle',
        message.channel || 'light',
        Number(message.delta) || 0
      );
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    case 'resetTerrainUniform': {
      if (!state.world) return;
      resetTerrainUniform(state.world);
      postSnapshot(true);
      renderFrame(true);
      return;
    }
    case 'reset': {
      if (!state.world) return;
      resetWorld(state.world);
      state.accumulator = 0;
      state.terrainHistory.undo.length = 0;
      state.terrainHistory.redo.length = 0;
      postSnapshot(true);
      renderFrame(true);
      postTerrainHistoryState('reset');
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
    case 'pushTerrainHistory': {
      if (!state.world) return;
      pushTerrainHistory(message.clearRedo !== false);
      return;
    }
    case 'undoTerrainEdit': {
      undoTerrainEdit();
      return;
    }
    case 'redoTerrainEdit': {
      redoTerrainEdit();
      return;
    }
    default:
      return;
  }
};

setInterval(step, 8);
