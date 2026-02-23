export const CellType = Object.freeze({ EMPTY: 0, PLANT: 1, HERBIVORE: 2, WALL: 3 });

export const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
export const MAX_NEIGHBOR_COUNT = NEIGHBORS.length;

export const RNG_MAX_OPEN = 0.9999999999999999;

export const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const createGrid = (size) => ({
  biomass: new Float32Array(size),
  energy: new Float32Array(size),
  gene: new Float32Array(size),
  age: new Float32Array(size),
  type: new Uint8Array(size)
});

export const buildNeighborCache = (width, height) => {
  const size = width * height;
  const indices = new Int32Array(size * MAX_NEIGHBOR_COUNT);
  const counts = new Uint8Array(size);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const base = i * MAX_NEIGHBOR_COUNT;
    let count = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      indices[base + count] = ny * width + nx;
      count++;
    }
    counts[i] = count;
  }
  return { indices, counts };
};

export const toIndex = (world, x, y) => y * world.width + x;

export const writeCell = (grid, i, patch) => {
  if (patch.type !== undefined) grid.type[i] = patch.type;
  if (patch.biomass !== undefined) grid.biomass[i] = clamp01(patch.biomass);
  if (patch.energy !== undefined) grid.energy[i] = patch.energy;
  if (patch.gene !== undefined) grid.gene[i] = clamp01(patch.gene);
  if (patch.age !== undefined) grid.age[i] = patch.age;
};

export const writeBoth = (world, i, patch) => {
  if (patch.type !== undefined) {
    const prevType = world.front.type[i];
    const nextType = patch.type;
    if (prevType !== nextType) {
      if (prevType === CellType.WALL) world.wallCount--;
      if (nextType === CellType.WALL) world.wallCount++;
    }
  }
  writeCell(world.front, i, patch);
  writeCell(world.back, i, patch);
};

