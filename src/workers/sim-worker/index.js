import { applyBrush, computeStats, createWorld, randomSeed, resetWorld, tick, loadPreset } from '../../sim/index.js';
import { applyTerrainBrush, resetTerrainUniform } from './terrain.js';
import { createWorkerRenderer } from './render.js';
import { createSnapshotPublisher } from './snapshots.js';
import { createTerrainHistoryController } from './history.js';

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

const clampSpeed = (v) => Math.max(0.2, Math.min(960, v));
const clampSunSpeed = (v) => Math.max(0.004, Math.min(0.12, v));

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

const renderer = createWorkerRenderer({
  state,
  reportWorkerError,
  renderIntervalMs: RENDER_INTERVAL_MS,
  cellValuesMinZoom: CELL_VALUES_MIN_ZOOM
});
const snapshots = createSnapshotPublisher({
  state,
  computeStats,
  postMessage: (message, transferables) => self.postMessage(message, transferables || []),
  controlWriteSlot: CTRL_WRITE_SLOT,
  controlVersion: CTRL_VERSION
});

const { applyView, initRenderer, setCanvasSize, renderFrame } = renderer;
const { updateSnapshotInterval, postSnapshot, initSharedChannels } = snapshots;

const terrainHistory = createTerrainHistoryController({
  state,
  postMessage: (message) => self.postMessage(message),
  postSnapshot,
  renderFrame
});

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
      state.world.config.polarDay = !!message.polarDay;
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
      terrainHistory.resetStacks();
      initSharedChannels(message.shared, state.world.size);
      initRenderer(message.offscreen, message.offscreen?.width, message.offscreen?.height);
      updateSnapshotInterval();
      applyView(0, 0, state.world.width, state.world.height, 1, false, 'eco');
      const seedCount = Number(message.seedCount) || 0;
      if (seedCount > 0) randomSeed(state.world, seedCount);
      postSnapshot(true);
      renderFrame(true);
      terrainHistory.postState('init');
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
    case 'setPolarDayMode': {
      if (!state.world) return;
      state.world.config.polarDay = !!message.value;
      return;
    }
    case 'setView': {
      if (!state.world) return;
      applyView(message.sx, message.sy, message.sw, message.sh, message.zoom, message.showCellValues, message.viewMode);
      if (typeof message.showAgingGlow === 'boolean') state.showAgingGlow = message.showAgingGlow;
      // 仅在“能量传输视图”下开启 flow 追踪，避免 tick 热路径常态开销。
      state.world.config.trackFlow = message.viewMode === 'transfer';
      updateSnapshotInterval();
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
      terrainHistory.resetStacks();
      postSnapshot(true);
      renderFrame(true);
      terrainHistory.postState('reset');
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
      terrainHistory.push(message.clearRedo !== false);
      return;
    }
    case 'undoTerrainEdit': {
      terrainHistory.undo();
      return;
    }
    case 'redoTerrainEdit': {
      terrainHistory.redo();
      return;
    }
    default:
      return;
  }
};

setInterval(step, 8);
