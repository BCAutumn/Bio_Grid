const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function screenToGrid(event, simCanvas, currentView) {
  const rect = simCanvas.getBoundingClientRect();
  const nx = clamp((event.clientX - rect.left) / rect.width, 0, 0.999999);
  const ny = clamp((event.clientY - rect.top) / rect.height, 0, 0.999999);
  const view = currentView();
  return [Math.floor(view.sx + nx * view.sw), Math.floor(view.sy + ny * view.sh)];
}

function activeMode(event) {
  const usingMiddle = (event.buttons & 4) === 4 || event.button === 1;
  const usingRight = (event.buttons & 2) === 2 || event.button === 2;
  if (usingMiddle) return 'wall';
  if (usingRight) return event.shiftKey ? 'annihilate' : 'disturb';
  return 'life';
}

export function bindInteractions({
  simCanvas,
  panel,
  baseHint,
  cellValuesMinZoom,
  state,
  camera,
  world,
  buttons,
  inputs,
  sendToWorker,
  setZoom,
  zoomAt,
  currentView,
  applyCameraBounds,
  syncViewToWorker,
  syncReadouts,
  onResetState,
  onResize
}) {
  const {
    btnPause,
    btnReset,
    btnSeed,
    btnViewReset,
    btnCellValues
  } = buttons;
  const {
    speedInput,
    radiusInput,
    geneInput,
    sunSpeedInput,
    zoomInput
  } = inputs;

  function paintFromEvent(event) {
    const [gx, gy] = screenToGrid(event, simCanvas, currentView);
    const radius = Number(radiusInput.value);
    const mode = activeMode(event);
    if (mode === 'life') {
      sendToWorker({ type: 'applyBrush', cx: gx, cy: gy, radius, mode, options: { gene: Number(geneInput.value), energy: 24 } });
    } else {
      sendToWorker({ type: 'applyBrush', cx: gx, cy: gy, radius, mode });
    }
    panel.hint.textContent = mode === 'life' ? '生命之笔' : mode === 'disturb' ? '轻度扰动 (右键)' : mode === 'annihilate' ? '重度毁灭 (Shift + 右键)' : '墙体绘制 (中键)';
  }

  btnPause.addEventListener('click', () => {
    state.running = !state.running;
    btnPause.textContent = state.running ? '暂停' : '继续';
    sendToWorker({ type: 'setRunning', running: state.running });
  });

  btnReset.addEventListener('click', () => {
    if (typeof onResetState === 'function') onResetState();
    sendToWorker({ type: 'reset' });
    panel.hint.textContent = '世界已清空';
  });

  btnSeed.addEventListener('click', () => {
    sendToWorker({ type: 'randomSeed', count: 160 });
    panel.hint.textContent = '已随机播种';
  });

  btnViewReset.addEventListener('click', () => {
    camera.x = world.width / 2;
    camera.y = world.height / 2;
    setZoom(1);
    panel.hint.textContent = '视角已重置';
  });

  btnCellValues.addEventListener('click', () => {
    state.showCellValues = !state.showCellValues;
    syncViewToWorker();
    syncReadouts();
    panel.hint.textContent = state.showCellValues
      ? (camera.zoom >= cellValuesMinZoom ? '格子数值已开启' : `格子数值已开启，放大到 ${cellValuesMinZoom}x 后显示`)
      : '格子数值已关闭';
  });

  speedInput.addEventListener('input', () => {
    state.ticksPerSecond = Number(speedInput.value);
    sendToWorker({ type: 'setTicksPerSecond', value: state.ticksPerSecond });
    syncReadouts();
  });

  sunSpeedInput.addEventListener('input', () => {
    const sunSpeed = Number(sunSpeedInput.value);
    world.config.sunSpeed = sunSpeed;
    sendToWorker({ type: 'setSunSpeed', value: sunSpeed });
    syncReadouts();
  });

  zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));

  simCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  simCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
  simCanvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    simCanvas.setPointerCapture(event.pointerId);
    if (state.spaceDown) {
      const view = currentView();
      state.pointerMode = 'pan';
      state.panStart = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y, sw: view.sw, sh: view.sh };
      panel.hint.textContent = '平移视角中';
      return;
    }
    state.pointerMode = 'paint';
    paintFromEvent(event);
  });

  simCanvas.addEventListener('pointermove', (event) => {
    if (state.pointerMode === 'paint') {
      paintFromEvent(event);
      return;
    }
    if (state.pointerMode === 'pan' && state.panStart) {
      const dx = event.clientX - state.panStart.x;
      const dy = event.clientY - state.panStart.y;
      camera.x = state.panStart.cx - (dx / simCanvas.width) * state.panStart.sw;
      camera.y = state.panStart.cy - (dy / simCanvas.height) * state.panStart.sh;
      applyCameraBounds();
      syncViewToWorker();
    }
  });

  const endPointerAction = () => {
    state.pointerMode = 'none';
    state.panStart = null;
    panel.hint.textContent = baseHint;
  };

  simCanvas.addEventListener('pointerup', endPointerAction);
  simCanvas.addEventListener('pointercancel', endPointerAction);
  simCanvas.addEventListener('lostpointercapture', endPointerAction);

  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Space') return;
    state.spaceDown = true;
    event.preventDefault();
  });

  window.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    state.spaceDown = false;
    if (state.pointerMode === 'none') panel.hint.textContent = baseHint;
  });

  if (typeof onResize === 'function') window.addEventListener('resize', onResize);
}
