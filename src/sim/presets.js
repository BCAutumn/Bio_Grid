import { CellType, writeBoth } from './shared.js';
import { resetWorld, setCell } from './world.js';

export function loadPreset(world, presetName, rng = Math.random) {
  resetWorld(world);
  if (presetName === 'empty') return;
  const { width, height } = world;
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  if (presetName === 'fourRooms') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.abs(x - cx) < 2 || Math.abs(y - cy) < 2) {
          // Leave gaps for doors
          if (Math.abs(x - cx) < 2 && Math.abs(y - cy) > 10 && y % 30 < 6) continue;
          if (Math.abs(y - cy) < 2 && Math.abs(x - cx) > 10 && x % 30 < 6) continue;
          setCell(world, x, y, { type: CellType.WALL });
        }
      }
    }
  } else if (presetName === 'border') {
    for (let x = 0; x < width; x++) {
      setCell(world, x, 0, { type: CellType.WALL });
      setCell(world, x, height - 1, { type: CellType.WALL });
    }
    for (let y = 0; y < height; y++) {
      setCell(world, 0, y, { type: CellType.WALL });
      setCell(world, width - 1, y, { type: CellType.WALL });
    }
  } else if (presetName === 'hourglass') {
    // 沙漏：两侧收窄到中心的墙体轮廓（留出上下通道）
    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;
    for (let y = 0; y < h; y++) {
      const t = h <= 1 ? 0 : y / (h - 1);
      const squeeze = Math.abs(t - 0.5) * 2; // 1 at top/bottom, 0 at center
      const margin = Math.floor((w * 0.38) * (1 - squeeze));
      const left = pad + margin;
      const right = width - 1 - pad - margin;
      if (y + pad === pad || y + pad === height - 1 - pad) continue;
      setCell(world, left, y + pad, { type: CellType.WALL });
      setCell(world, right, y + pad, { type: CellType.WALL });
    }
    // 加一条中心横杠，形成典型沙漏“瓶颈”
    for (let x = pad + Math.floor(w * 0.44); x <= pad + Math.floor(w * 0.56); x++) {
      setCell(world, x, cy, { type: CellType.WALL });
    }
  } else if (presetName === 'rings') {
    // 同心方环：每隔 step 一圈墙。
    // 注意：繁殖规则要求目标空格能找到“第二亲本”（co-parent），单格门洞会让门洞外侧格子
    // 往往只邻接到门洞内那一株植物（其它邻接格是墙），导致几乎无法跨环扩散。
    // 所以这里每圈只开 1 个口，但门洞至少 3 格宽，保证能繁衍到外圈。
    const step = 14;
    const maxRing = Math.min(Math.floor(width / 2), Math.floor(height / 2)) - 2;
    for (let r = step; r <= maxRing; r += step) {
      const x0 = cx - r;
      const x1 = cx + r;
      const y0 = cy - r;
      const y1 = cy + r;

      // 先画完整一圈墙
      for (let x = x0; x <= x1; x++) {
        setCell(world, x, y0, { type: CellType.WALL });
        setCell(world, x, y1, { type: CellType.WALL });
      }
      for (let y = y0; y <= y1; y++) {
        setCell(world, x0, y, { type: CellType.WALL });
        setCell(world, x1, y, { type: CellType.WALL });
      }

      // 再凿开口（至少 3 格宽）
      const clear = (x, y) => setCell(world, x, y, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
      const doorHalf = 1; // 3 格宽：[-1, 0, +1]
      const doorSide = (rng() * 4) | 0; // 0=top,1=bottom,2=left,3=right
      // 避免开在角上：范围 [1, 2r-1]
      const centerPos = r <= 1 ? 1 : 1 + (((rng() * Math.max(1, 2 * r - 1)) | 0) % Math.max(1, 2 * r - 1));

      if (doorSide === 0) {
        // top
        for (let dx = -doorHalf; dx <= doorHalf; dx++) clear(x0 + centerPos + dx, y0);
      } else if (doorSide === 1) {
        // bottom
        for (let dx = -doorHalf; dx <= doorHalf; dx++) clear(x0 + centerPos + dx, y1);
      } else if (doorSide === 2) {
        // left
        for (let dy = -doorHalf; dy <= doorHalf; dy++) clear(x0, y0 + centerPos + dy);
      } else {
        // right
        for (let dy = -doorHalf; dy <= doorHalf; dy++) clear(x1, y0 + centerPos + dy);
      }
    }
  } else if (presetName === 'maze') {
    // 真·迷宫：递归回溯（深度优先）生成“完美迷宫”（无环、连通）
    // 采用缩放映射：通道宽 2，墙厚 1（避免“加宽 carve 直接抹掉内部墙体”导致只剩外圈）。
    const wallType = CellType.WALL;
    for (const grid of [world.front, world.back]) {
      grid.type.fill(wallType);
      grid.biomass.fill(0);
      grid.energy.fill(0);
      grid.gene.fill(0);
      grid.age.fill(0);
    }
    world.wallCount = world.size;

    const SCALE = 3; // 每个迷宫 cell 占 3x3：2x2 通道 + 1 厚墙
    const cellsW = ((width - 2) / SCALE) | 0;
    const cellsH = ((height - 2) / SCALE) | 0;
    if (cellsW <= 1 || cellsH <= 1) return;
    const cellCount = cellsW * cellsH;
    const visited = new Uint8Array(cellCount);
    const stack = new Int32Array(cellCount);
    let sp = 0;

    const openAt = (gx, gy) => {
      if (gx < 0 || gy < 0 || gx >= width || gy >= height) return;
      const i = gy * width + gx;
      if (world.front.type[i] !== wallType) return;
      writeBoth(world, i, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
    };

    const cellToGrid = (cx0, cy0) => [1 + cx0 * SCALE, 1 + cy0 * SCALE];

    const carveRoom = (cx0, cy0) => {
      const [gx, gy] = cellToGrid(cx0, cy0);
      openAt(gx, gy);
      openAt(gx + 1, gy);
      openAt(gx, gy + 1);
      openAt(gx + 1, gy + 1);
      return [gx, gy];
    };

    const carveDoor = (fromCx, fromCy, dx, dy) => {
      const [gx, gy] = cellToGrid(fromCx, fromCy);
      if (dx === 1) {
        openAt(gx + 2, gy);
        openAt(gx + 2, gy + 1);
      } else if (dx === -1) {
        openAt(gx - 1, gy);
        openAt(gx - 1, gy + 1);
      } else if (dy === 1) {
        openAt(gx, gy + 2);
        openAt(gx + 1, gy + 2);
      } else if (dy === -1) {
        openAt(gx, gy - 1);
        openAt(gx + 1, gy - 1);
      }
    };

    const startCx = (rng() * cellsW) | 0;
    const startCy = (rng() * cellsH) | 0;
    let current = startCy * cellsW + startCx;
    visited[current] = 1;
    stack[sp++] = current;
    carveRoom(startCx, startCy);

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    while (sp > 0) {
      current = stack[sp - 1];
      const cx0 = current % cellsW;
      const cy0 = (current / cellsW) | 0;

      // 收集未访问邻居
      let options = 0;
      const opts = new Int32Array(4);
      for (let d = 0; d < 4; d++) {
        const nx = cx0 + dirs[d][0];
        const ny = cy0 + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= cellsW || ny >= cellsH) continue;
        const ni = ny * cellsW + nx;
        if (visited[ni]) continue;
        opts[options++] = (d << 24) | ni;
      }

      if (options === 0) {
        sp--;
        continue;
      }

      const pick = (rng() * options) | 0;
      const packed = opts[pick];
      const next = packed & 0xffffff;
      visited[next] = 1;
      stack[sp++] = next;

      const nx = next % cellsW;
      const ny = (next / cellsW) | 0;
      const dx = nx - cx0;
      const dy = ny - cy0;
      carveDoor(cx0, cy0, dx, dy); // 打通墙
      carveRoom(nx, ny); // 打通新房间
    }

    // 开两个出入口
    {
      const [ex, ey] = cellToGrid(0, 0);
      openAt(ex, 0);
      openAt(ex + 1, 0);
      openAt(ex, 1);
      openAt(ex + 1, 1);
      void ey;
    }
    {
      const [xx] = cellToGrid(cellsW - 1, cellsH - 1);
      openAt(xx, height - 1);
      openAt(xx + 1, height - 1);
      openAt(xx, height - 2);
      openAt(xx + 1, height - 2);
    }
  }
}

