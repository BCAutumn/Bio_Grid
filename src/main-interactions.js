const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function screenToGrid(event, simCanvas, currentView) {
  const rect = simCanvas.getBoundingClientRect();
  const nx = clamp((event.clientX - rect.left) / rect.width, 0, 0.999999);
  const ny = clamp((event.clientY - rect.top) / rect.height, 0, 0.999999);
  const view = currentView();
  return [Math.floor(view.sx + nx * view.sw), Math.floor(view.sy + ny * view.sh)];
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
    btnCellValues,
    btnAgingGlow,
    btnPolarDay,
    btnModeLife,
    btnModeDisturb,
    btnModeAnnihilate,
    btnModeWall,
    btnModeErase,
    btnModeLightUp,
    btnModeLightDown,
    btnModeLossUp,
    btnModeLossDown,
    btnShapeCircle,
    btnShapeSquare,
    btnShapeRect,
    btnShapeTriangle,
    btnViewEco,
    btnViewTerrainLight,
    btnViewTerrainLoss,
    btnViewTerrainMix,
    btnViewTransfer,
    btnPresetEmpty,
    btnPresetFourRooms,
    btnPresetMaze,
    btnPresetFiveZones,
    btnPresetHourglass,
    btnPresetRings,
    btnPresetVerticalGradient,
    btnMapUndo,
    btnMapRedo,
    btnTerrainUniformReset
  } = buttons;
  const {
    speedInput,
    radiusInput,
    radiusInputMap,
    geneInput,
    sunSpeedInput,
    zoomInput,
    terrainStrengthInput
  } = inputs;

  function paintFromEvent(event) {
    const [gx, gy] = screenToGrid(event, simCanvas, currentView);
    const radius = Number(radiusInput.value);
    const mode = state.brushMode || 'life';
    const shape = state.brushShape || 'circle';
    const options = { gene: Number(geneInput.value), energy: 24, shape };
    if (mode === 'terrainLightUp' || mode === 'terrainLightDown' || mode === 'terrainLossUp' || mode === 'terrainLossDown') {
      const channel = mode.includes('Light') ? 'light' : 'loss';
      const direction = (mode.endsWith('Up') ? 1 : -1);
      const strength = Number(terrainStrengthInput?.value ?? 0.08);
      sendToWorker({ type: 'applyTerrainBrush', cx: gx, cy: gy, radius, shape, channel, delta: direction * strength });
      return;
    }
    sendToWorker({ type: 'applyBrush', cx: gx, cy: gy, radius, mode, options });
  }

  const brushButtons = [
    { btn: btnModeLife, mode: 'life', label: '播种', cursor: 'crosshair' },
    { btn: btnModeDisturb, mode: 'disturb', label: '干扰', cursor: 'crosshair' },
    { btn: btnModeAnnihilate, mode: 'annihilate', label: '毁灭', cursor: 'crosshair' },
    { btn: btnModeWall, mode: 'wall', label: '墙体', cursor: 'crosshair' },
    { btn: btnModeErase, mode: 'erase', label: '擦除', cursor: 'crosshair' },
    { btn: btnModeLightUp, mode: 'terrainLightUp', label: '光照+', cursor: 'crosshair' },
    { btn: btnModeLightDown, mode: 'terrainLightDown', label: '光照-', cursor: 'crosshair' },
    { btn: btnModeLossUp, mode: 'terrainLossUp', label: '流失+', cursor: 'crosshair' },
    { btn: btnModeLossDown, mode: 'terrainLossDown', label: '流失-', cursor: 'crosshair' }
  ];

  function updateCanvasCursor() {
    const mode = state.brushMode || 'life';
    const btn = brushButtons.find(b => b.mode === mode);
    simCanvas.style.cursor = btn?.cursor || 'crosshair';
  }

  brushButtons.forEach(({ btn, mode, label }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.brushMode = mode;
      brushButtons.forEach(b => b.btn && b.btn.classList.toggle('is-active', b.mode === mode));
      updateCanvasCursor();
      const text = `当前模式：${label}。左键拖动绘制；滚轮缩放；中键拖动平移。`;
      panel.hint.textContent = text;
    });
  });

  // 笔刷形状按钮
  const shapeButtons = [
    { btn: btnShapeCircle, shape: 'circle', label: '圆形' },
    { btn: btnShapeSquare, shape: 'square', label: '正方形' },
    { btn: btnShapeRect, shape: 'rect', label: '长方形' },
    { btn: btnShapeTriangle, shape: 'triangle', label: '三角形' }
  ];

  shapeButtons.forEach(({ btn, shape, label }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.brushShape = shape;
      shapeButtons.forEach(b => b.btn && b.btn.classList.toggle('is-active', b.shape === shape));
      panel.hint.textContent = `笔刷形状：${label}`;
    });
  });

  const viewButtons = [
    { btn: btnViewEco, mode: 'eco', label: '生态' },
    { btn: btnViewTerrainLight, mode: 'terrainLight', label: '地形光照' },
    { btn: btnViewTerrainLoss, mode: 'terrainLoss', label: '地形流失' },
    { btn: btnViewTerrainMix, mode: 'terrainMix', label: '复合地形' },
    { btn: btnViewTransfer, mode: 'transfer', label: '能量传输' }
  ];

  const applyViewMode = (mode, label) => {
    state.viewMode = mode;
    viewButtons.forEach(v => v.btn && v.btn.classList.toggle('is-active', v.mode === mode));
    syncViewToWorker();
    panel.hint.textContent = `当前视图：${label}`;
  };

  viewButtons.forEach(({ btn, mode, label }) => {
    if (!btn) return;
    btn.addEventListener('click', () => applyViewMode(mode, label));
  });

  const presetButtons = [
    { btn: btnPresetEmpty, preset: 'empty', label: '空地' },
    { btn: btnPresetFourRooms, preset: 'fourRooms', label: '四宫格' },
    { btn: btnPresetMaze, preset: 'maze', label: '迷宫' },
    { btn: btnPresetFiveZones, preset: 'fiveZones', label: '五区地形' },
    { btn: btnPresetHourglass, preset: 'hourglass', label: '沙漏' },
    { btn: btnPresetRings, preset: 'rings', label: '同心环' },
    { btn: btnPresetVerticalGradient, preset: 'verticalGradient', label: '纵向梯度' }
  ];

  presetButtons.forEach(({ btn, preset, label }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      sendToWorker({ type: 'pushTerrainHistory', clearRedo: true });
      sendToWorker({ type: 'loadPreset', presetName: preset });
      panel.hint.textContent = `已加载地图：${label}（可撤销）`;
    });
  });

  if (btnMapUndo) {
    btnMapUndo.addEventListener('click', () => {
      sendToWorker({ type: 'undoTerrainEdit' });
      panel.hint.textContent = '已请求撤销地图编辑';
    });
  }

  if (btnMapRedo) {
    btnMapRedo.addEventListener('click', () => {
      sendToWorker({ type: 'redoTerrainEdit' });
      panel.hint.textContent = '已请求重做地图编辑';
    });
  }

  if (btnTerrainUniformReset) {
    btnTerrainUniformReset.addEventListener('click', () => {
      sendToWorker({ type: 'pushTerrainHistory', clearRedo: true });
      sendToWorker({ type: 'resetTerrainUniform' });
      panel.hint.textContent = '已重置为均匀地形（光照=1，流失=1）';
    });
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

  if (btnAgingGlow) {
    btnAgingGlow.addEventListener('click', () => {
      state.showAgingGlow = !state.showAgingGlow;
      sendToWorker({ type: 'setShowAgingGlow', value: state.showAgingGlow });
      syncViewToWorker();
      syncReadouts();
      panel.hint.textContent = state.showAgingGlow ? '衰老预警已开启（即将老死的细胞发红光）' : '衰老预警已关闭';
    });
  }

  speedInput.addEventListener('input', () => {
    state.ticksPerSecond = Number(speedInput.value);
    sendToWorker({ type: 'setTicksPerSecond', value: state.ticksPerSecond });
    syncReadouts();
  });

  if (sunSpeedInput) {
    sunSpeedInput.addEventListener('input', () => {
      if (state.polarDayMode) return;
      const sunSpeed = Number(sunSpeedInput.value);
      world.config.sunSpeed = sunSpeed;
      sendToWorker({ type: 'setSunSpeed', value: sunSpeed });
      syncReadouts();
    });
  }

  if (btnPolarDay) {
    btnPolarDay.addEventListener('click', () => {
      state.polarDayMode = !state.polarDayMode;
      world.config.polarDay = state.polarDayMode;
      sendToWorker({ type: 'setPolarDayMode', value: state.polarDayMode });
      syncReadouts();
      panel.hint.textContent = state.polarDayMode
        ? '极昼模式已开启：恒定白天，昼夜速度已禁用，天数停止累计'
        : '极昼模式已关闭：恢复昼夜循环与天数累计';
    });
  }

  if (terrainStrengthInput) {
    terrainStrengthInput.addEventListener('input', () => {
      state.terrainBrushStrength = Number(terrainStrengthInput.value);
      syncReadouts();
    });
  }

  radiusInput.addEventListener('input', () => {
    if (radiusInputMap && radiusInputMap.value !== radiusInput.value) radiusInputMap.value = radiusInput.value;
    syncReadouts();
  });

  if (radiusInputMap) {
    radiusInputMap.addEventListener('input', () => {
      if (radiusInput.value !== radiusInputMap.value) radiusInput.value = radiusInputMap.value;
      syncReadouts();
    });
  }

  radiusInput.addEventListener('change', () => {
    if (radiusInputMap && radiusInputMap.value !== radiusInput.value) radiusInputMap.value = radiusInput.value;
    syncReadouts();
  });

  geneInput.addEventListener('input', () => {
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
    // 中键（button === 1）用于平移拖动
    if (event.button === 1) {
      simCanvas.setPointerCapture(event.pointerId);
      const view = currentView();
      state.pointerMode = 'pan';
      state.panStart = { x: event.clientX, y: event.clientY, cx: camera.x, cy: camera.y, sw: view.sw, sh: view.sh };
      simCanvas.style.cursor = 'grabbing';
      panel.hint.textContent = '平移视角中';
      return;
    }
    // 左键（button === 0）用于绘制
    if (event.button !== 0) return;
    simCanvas.setPointerCapture(event.pointerId);
    state.pointerMode = 'paint';
    if (
      state.brushMode === 'wall' ||
      state.brushMode === 'erase' ||
      state.brushMode === 'terrainLightUp' ||
      state.brushMode === 'terrainLightDown' ||
      state.brushMode === 'terrainLossUp' ||
      state.brushMode === 'terrainLossDown'
    ) {
      sendToWorker({ type: 'pushTerrainHistory', clearRedo: true });
    }
    paintFromEvent(event);
  });

  simCanvas.addEventListener('pointermove', (event) => {
    if (state.pointerMode === 'paint') {
      if ((event.buttons & 1) !== 1) return;
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
    simCanvas.style.cursor = brushButtons.find(b => b.mode === state.brushMode)?.cursor || 'crosshair';
    const modeLabel = brushButtons.find(b => b.mode === state.brushMode)?.label || '播种';
    panel.hint.textContent = `当前模式：${modeLabel}。左键拖动绘制；滚轮缩放；中键拖动平移。`;
  };

  simCanvas.addEventListener('pointerup', endPointerAction);
  simCanvas.addEventListener('pointercancel', endPointerAction);
  simCanvas.addEventListener('lostpointercapture', endPointerAction);


  if (typeof onResize === 'function') window.addEventListener('resize', onResize);
}
