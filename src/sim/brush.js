import { CellType, toIndex, writeBoth } from './shared.js';
import { setCell } from './world.js';

function inCircle(dx, dy, r) {
  return dx * dx + dy * dy <= r * r;
}

function inSquare(dx, dy, r) {
  return Math.abs(dx) <= r && Math.abs(dy) <= r;
}

function inRect(dx, dy, r) {
  // 长方形：宽是高的2倍
  return Math.abs(dx) <= r && Math.abs(dy) <= r * 0.5;
}

function inTriangle(dx, dy, r) {
  // 等边三角形：以(cx, cy)为顶点，向下展开
  // 顶点在 (0, -r)，底边在 y = r/2
  if (dy < -r || dy > r * 0.5) return false;
  // 三角形的边界线从顶点到底边两个角
  // 左边界: x = -r * (1 - (y + r) / (1.5 * r)) = -r * (0.5 - y/r) / 1.5 * 3?
  // 简化：在高度 h 处，半宽 = r * (1 - (h) / (1.5r)) 其中 h = y - (-r) = y + r
  const halfWidthAtY = r * (1 - (dy + r) / (1.5 * r));
  return Math.abs(dx) <= halfWidthAtY && halfWidthAtY > 0;
}

export function applyBrush(world, cx, cy, radius, mode, options = {}) {
  const shape = options.shape || 'circle';
  const r = radius;
  const sx = Math.max(0, Math.floor(cx - r));
  const ex = Math.min(world.width - 1, Math.ceil(cx + r));
  const sy = Math.max(0, Math.floor(cy - r));
  const ey = Math.min(world.height - 1, Math.ceil(cy + r));

  // 根据形状调整边界框
  let bounds = { sx, ex, sy, ey };
  if (shape === 'rect') {
    // 长方形高度是宽度的一半
    bounds.sy = Math.max(0, Math.floor(cy - r * 0.5));
    bounds.ey = Math.min(world.height - 1, Math.ceil(cy + r * 0.5));
  } else if (shape === 'triangle') {
    // 三角形顶点向上，底边向下
    bounds.sy = Math.max(0, Math.floor(cy - r));
    bounds.ey = Math.min(world.height - 1, Math.ceil(cy + r * 0.5));
  }

  const wallType = CellType.WALL;

  for (let y = bounds.sy; y <= bounds.ey; y++) {
    for (let x = bounds.sx; x <= bounds.ex; x++) {
      const dx = x - cx;
      const dy = y - cy;

      // 根据形状判断是否在内
      let inside = false;
      switch (shape) {
        case 'circle':
          inside = inCircle(dx, dy, r);
          break;
        case 'square':
          inside = inSquare(dx, dy, r);
          break;
        case 'rect':
          inside = inRect(dx, dy, r);
          break;
        case 'triangle':
          inside = inTriangle(dx, dy, r);
          break;
        default:
          inside = inCircle(dx, dy, r);
      }

      if (!inside) continue;

      const i = toIndex(world, x, y);
      if (mode === 'life') {
        // 播种不覆盖墙体：墙体只能通过"毁灭"或加载预设来移除。
        if (world.front.type[i] === wallType) continue;
        const g = options.gene ?? 0.5;
        const maxB = 1.8 - g * 0.8;
        writeBoth(world, i, { type: CellType.PLANT, biomass: Math.min(1, maxB), energy: options.energy ?? 24, gene: g, age: 0 });
      } else if (mode === 'disturb') {
        writeBoth(world, i, { energy: 0 });
      } else if (mode === 'annihilate' || mode === 'erase') {
        writeBoth(world, i, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
      } else if (mode === 'wall') {
        writeBoth(world, i, { type: CellType.WALL, biomass: 0, energy: 0, gene: 0, age: 0 });
      }
    }
  }
}

export function randomSeed(world, count = 140, rng = Math.random) {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * world.width);
    const y = Math.floor(rng() * world.height);
    setCell(world, x, y, { type: CellType.PLANT, biomass: 1, energy: 10 + rng() * 14, gene: rng() });
  }
}
