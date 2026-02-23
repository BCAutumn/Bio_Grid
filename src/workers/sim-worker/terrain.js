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

export function applyTerrainBrush(world, cx, cy, radius, shape, channel, delta) {
  const terrain = world.terrain;
  if (!terrain) return;
  const target = channel === 'loss' ? terrain.loss : terrain.light;
  const clampMin = channel === 'loss' ? (terrain.lossClampMin ?? terrain.lossMin) : (terrain.lightClampMin ?? terrain.lightMin);
  const clampMax = channel === 'loss' ? (terrain.lossClampMax ?? terrain.lossMax) : (terrain.lightClampMax ?? terrain.lightMax);
  const r = Math.max(1, Number(radius) || 1);
  const sx = Math.max(0, Math.floor(cx - r));
  const ex = Math.min(world.width - 1, Math.ceil(cx + r));
  const sy = Math.max(0, Math.floor(cy - r));
  const ey = Math.min(world.height - 1, Math.ceil(cy + r));
  const amount = Number(delta) || 0;
  if (!amount) return;

  let localMin = Infinity;
  let localMax = -Infinity;
  for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
    const dx = x - cx;
    const dy = y - cy;
    if (!inBrushShape(dx, dy, r, shape)) continue;
    const i = y * world.width + x;
    const next = clamp(target[i] + amount, clampMin, clampMax);
    target[i] = next;
    if (next < localMin) localMin = next;
    if (next > localMax) localMax = next;
  }

  // 轻量级更新显示归一化范围：只在“扩展边界”时更新，避免每次笔刷都全图扫描。
  if (Number.isFinite(localMin) && Number.isFinite(localMax)) {
    if (channel === 'loss') {
      if (!Number.isFinite(terrain.lossMin) || localMin < terrain.lossMin) terrain.lossMin = localMin;
      if (!Number.isFinite(terrain.lossMax) || localMax > terrain.lossMax) terrain.lossMax = localMax;
    } else {
      if (!Number.isFinite(terrain.lightMin) || localMin < terrain.lightMin) terrain.lightMin = localMin;
      if (!Number.isFinite(terrain.lightMax) || localMax > terrain.lightMax) terrain.lightMax = localMax;
    }
  }
}

export function resetTerrainUniform(world) {
  if (!world?.terrain) return;
  world.terrain.light.fill(1);
  world.terrain.loss.fill(1);
  world.terrain.lightMin = 1;
  world.terrain.lightMax = 1;
  world.terrain.lossMin = 1;
  world.terrain.lossMax = 1;
}
