import { drawCellValuesOverlay, drawFlowOverlay, paintWorldToPixels } from '../../render.js';

export function createWorkerRenderer({ state, reportWorkerError, renderIntervalMs, cellValuesMinZoom }) {
  function applyView(sx, sy, sw, sh, zoom, showCellValues, viewMode) {
    const world = state.world;
    if (!world) return;
    const safeSw = Number.isFinite(sw) && sw > 0 ? sw : world.width;
    const safeSh = Number.isFinite(sh) && sh > 0 ? sh : world.height;
    state.render.view = {
      sx: Number.isFinite(sx) ? sx : 0,
      sy: Number.isFinite(sy) ? sy : 0,
      sw: safeSw,
      sh: safeSh
    };
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

  function renderFrame(force = false) {
    if (state.render.mode !== 'worker' || !state.world) return;
    try {
      const now = performance.now();
      const interval = state.render.viewMode === 'transfer' ? 120 : renderIntervalMs;
      if (!force && now - state.render.lastRenderTs < interval) return;
      state.render.lastRenderTs = now;

      const { world, render } = state;
      const view = render.view || { sx: 0, sy: 0, sw: world.width, sh: world.height };
      paintWorldToPixels(world, render.frame.data, { showAgingGlow: state.showAgingGlow, viewMode: render.viewMode, nowMs: now });
      render.bufferCtx.putImageData(render.frame, 0, 0);
      render.ctx.imageSmoothingEnabled = false;
      render.ctx.clearRect(0, 0, render.width, render.height);
      render.ctx.drawImage(render.bufferCanvas, view.sx, view.sy, view.sw, view.sh, 0, 0, render.width, render.height);
      if (render.viewMode === 'transfer') {
        drawFlowOverlay(render.ctx, world, view, render.width, render.height, now);
      }
      if (render.showCellValues && render.zoom >= cellValuesMinZoom) {
        drawCellValuesOverlay(render.ctx, world, view, render.width, render.height);
      }
    } catch (error) {
      reportWorkerError('renderFrame', error);
    }
  }

  return { applyView, initRenderer, setCanvasSize, renderFrame };
}
