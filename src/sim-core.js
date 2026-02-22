export const CellType = Object.freeze({ EMPTY: 0, PLANT: 1, HERBIVORE: 2, WALL: 3 });
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const MAX_NEIGHBOR_COUNT = NEIGHBORS.length;
const SCRATCH_EMPTY_NEIGHBORS = new Int32Array(8);
const SCRATCH_DIFFUSE_NEIGHBORS = new Int32Array(8);
const DEFAULT_CONFIG = Object.freeze({
  timeStep: 0.05,
  sunSpeed: 0.014,
  diffuseSelf: 0.8,
  diffuseNeighbor: 0.2,
  baseCost: 0.002,
  geneCostFactor: 0.06,
  growthRate: 0.03,
  decayRate: 0.02,
  reproBiomass: 0.92,
  reproEnergy: 8,
  childBiomass: 0.32,
  mutationStep: 0.04,
  isolationEnergyLoss: 0.02,
  crowdNeighborSoft: 6,
  crowdEnergyLoss: 0.004,
  reproNeighborCap: 4,
  maxEnergy: 36
});
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const RNG_MAX_OPEN = 0.9999999999999999;
const createGrid = (size) => ({
  biomass: new Float32Array(size),
  energy: new Float32Array(size),
  gene: new Float32Array(size),
  type: new Uint8Array(size)
});
const buildNeighborCache = (width, height) => {
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
export function createWorld(width = 160, height = 160, config = {}) {
  const size = width * height;
  return {
    width,
    height,
    size,
    time: 0,
    sunlight: 0,
    config: { ...DEFAULT_CONFIG, ...config },
    extensions: { typeUpdaters: {} },
    neighbors: buildNeighborCache(width, height),
    wallCount: 0,
    scratch: {
      reproEligible: new Uint8Array(size)
    },
    front: createGrid(size),
    back: createGrid(size),
    stats: { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, sunlight: 0 }
  };
}
export const toIndex = (world, x, y) => y * world.width + x;
const writeCell = (grid, i, patch) => {
  if (patch.type !== undefined) grid.type[i] = patch.type;
  if (patch.biomass !== undefined) grid.biomass[i] = clamp01(patch.biomass);
  if (patch.energy !== undefined) grid.energy[i] = patch.energy;
  if (patch.gene !== undefined) grid.gene[i] = clamp01(patch.gene);
};
const writeBoth = (world, i, patch) => {
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
export function setCell(world, x, y, patch) {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
  writeBoth(world, toIndex(world, x, y), patch);
}
export function applyBrush(world, cx, cy, radius, mode, options = {}) {
  const r2 = radius * radius;
  const sx = Math.max(0, Math.floor(cx - radius));
  const ex = Math.min(world.width - 1, Math.ceil(cx + radius));
  const sy = Math.max(0, Math.floor(cy - radius));
  const ey = Math.min(world.height - 1, Math.ceil(cy + radius));
  for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy > r2) continue;
    const i = toIndex(world, x, y);
    if (mode === 'life') writeBoth(world, i, { type: CellType.PLANT, biomass: 1, energy: options.energy ?? 24, gene: options.gene ?? 0.5 });
    else if (mode === 'disturb') writeBoth(world, i, { energy: 0 });
    else if (mode === 'annihilate') writeBoth(world, i, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0 });
    else if (mode === 'wall') writeBoth(world, i, { type: CellType.WALL, biomass: 0, energy: 0, gene: 0 });
  }
}
export function randomSeed(world, count = 140, rng = Math.random) {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * world.width);
    const y = Math.floor(rng() * world.height);
    setCell(world, x, y, { type: CellType.PLANT, biomass: 1, energy: 10 + rng() * 14, gene: rng() });
  }
}
export function resetWorld(world) {
  for (const grid of [world.front, world.back]) {
    grid.type.fill(0);
    grid.biomass.fill(0);
    grid.energy.fill(0);
    grid.gene.fill(0);
  }
  world.time = 0;
  world.sunlight = 0;
  world.wallCount = 0;
  world.stats = { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, sunlight: 0 };
}
export function tick(world, rng = Math.random) {
  const { config, front: a, back: b } = world;
  const size = world.size;
  const neighborIndices = world.neighbors.indices;
  const neighborCounts = world.neighbors.counts;
  const emptyNeighbors = SCRATCH_EMPTY_NEIGHBORS;
  const diffuseNeighbors = SCRATCH_DIFFUSE_NEIGHBORS;
  const reproEligible = world.scratch.reproEligible;
  const typeUpdaters = world.extensions.typeUpdaters;
  const aType = a.type;
  const aBiomass = a.biomass;
  const aEnergy = a.energy;
  const aGene = a.gene;
  const bType = b.type;
  const bBiomass = b.biomass;
  const bEnergy = b.energy;
  const bGene = b.gene;
  const wallType = CellType.WALL;
  const plantType = CellType.PLANT;
  const emptyType = CellType.EMPTY;
  const hasWalls = world.wallCount > 0;
  world.time += config.timeStep;
  const rawSunlight = Math.sin(world.time * config.sunSpeed);
  const sunlight = rawSunlight > 0 ? rawSunlight : 0;
  world.sunlight = sunlight;
  const diffuseSelf = config.diffuseSelf;
  const diffuseNeighbor = config.diffuseNeighbor;
  const norm = diffuseSelf + diffuseNeighbor;
  const keepFrac = norm > 0 ? diffuseSelf / norm : 0;
  const outFrac = norm > 0 ? diffuseNeighbor / norm : 0;
  const baseCost = config.baseCost;
  const geneCostFactor = config.geneCostFactor;
  const growthRate = config.growthRate;
  const decayRate = config.decayRate;
  const isolationEnergyLoss = config.isolationEnergyLoss;
  const crowdNeighborSoft = config.crowdNeighborSoft;
  const crowdEnergyLoss = config.crowdEnergyLoss;
  const reproNeighborCap = config.reproNeighborCap;
  const reproBiomass = config.reproBiomass;
  const reproEnergy = config.reproEnergy;
  const childBiomass = config.childBiomass;
  const mutationStep = config.mutationStep;
  const maxEnergy = config.maxEnergy;

  bType.set(aType);
  bBiomass.fill(0);
  bGene.fill(0);
  bEnergy.fill(0);
  for (let i = 0; i < size; i++) {
    if (hasWalls && aType[i] === wallType) {
      continue;
    }
    const rawSelfE = aEnergy[i];
    if (rawSelfE <= 0) continue;
    const selfE = rawSelfE;
    bEnergy[i] += selfE * keepFrac;

    const out = selfE * outFrac;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    if (!hasWalls) {
      if (neighborCount > 0) {
        const share = out / neighborCount;
        for (let n = 0; n < neighborCount; n++) bEnergy[neighborIndices[base + n]] += share;
      } else {
        bEnergy[i] += out;
      }
      continue;
    }
    let deg = 0;
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      if (aType[ni] === wallType) continue;
      diffuseNeighbors[deg++] = ni;
    }
    if (deg > 0) {
      const share = out / deg;
      for (let k = 0; k < deg; k++) bEnergy[diffuseNeighbors[k]] += share;
    } else {
      bEnergy[i] += out;
    }
  }
  for (let i = 0; i < size; i++) {
    reproEligible[i] = aType[i] === plantType && aBiomass[i] > reproBiomass && aEnergy[i] > reproEnergy ? 1 : 0;
  }
  for (let i = 0; i < size; i++) {
    if (aType[i] !== plantType) {
      const nextType = bType[i];
      if (nextType === emptyType || nextType === wallType || nextType === plantType) {
        // empty/wall 维持 0；若是新生植物则保留其已写入数据。
      } else {
        bBiomass[i] = aBiomass[i];
        bGene[i] = aGene[i];
        const updater = typeUpdaters[nextType];
        if (updater) updater({ index: i, world, read: a, write: b, rng });
      }
      continue;
    }
    const rawGene = aGene[i];
    const gene = rawGene < 0 ? 0 : rawGene > 1 ? 1 : rawGene;
    const income = sunlight * (0.1 + gene * 0.9);
    const cost = baseCost + gene * gene * geneCostFactor;
    let energy = bEnergy[i] + income - cost;
    let plantNeighbors = 0;
    let emptyCount = 0;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      const readType = aType[ni];
      if (readType === plantType) plantNeighbors++;
      if (readType === emptyType && bType[ni] === emptyType) emptyNeighbors[emptyCount++] = ni;
    }
    if (plantNeighbors < 2) {
      energy -= isolationEnergyLoss;
    } else if (plantNeighbors > crowdNeighborSoft) {
      const localCrowd = plantNeighbors - crowdNeighborSoft;
      energy -= localCrowd * crowdEnergyLoss;
    }
    bGene[i] = gene;
    const cappedEnergy = energy < maxEnergy ? energy : maxEnergy;
    bEnergy[i] = cappedEnergy;
    const nextBiomassRaw = aBiomass[i] + (cappedEnergy > 0 ? growthRate : -decayRate);
    const nextBiomass = nextBiomassRaw < 0 ? 0 : nextBiomassRaw > 1 ? 1 : nextBiomassRaw;
    bBiomass[i] = nextBiomass;
    if (nextBiomass <= 0) {
      bType[i] = emptyType;
      bEnergy[i] = 0;
      bGene[i] = 0;
      continue;
    }
    if (emptyCount > 0 && plantNeighbors >= 1 && plantNeighbors <= reproNeighborCap && nextBiomass > reproBiomass && cappedEnergy > reproEnergy) {
      let chosenEmpty = -1;
      let chosenCoParent = -1;
      let validEmptyCount = 0;
      for (let k = 0; k < emptyCount; k++) {
        const empty = emptyNeighbors[k];
        let coParent = -1;
        let coParentCount = 0;
        const emptyBase = empty * MAX_NEIGHBOR_COUNT;
        const emptyNeighborCount = neighborCounts[empty];
        for (let n = 0; n < emptyNeighborCount; n++) {
          const ni = neighborIndices[emptyBase + n];
          if (ni === i) continue;
          if (!reproEligible[ni]) continue;
          coParentCount++;
          const roll = rng();
          const boundedRoll = roll < 1 ? roll : RNG_MAX_OPEN;
          if (((boundedRoll * coParentCount) | 0) === 0) coParent = ni;
        }
        if (coParent < 0) continue;
        validEmptyCount++;
        const roll = rng();
        const boundedRoll = roll < 1 ? roll : RNG_MAX_OPEN;
        if (((boundedRoll * validEmptyCount) | 0) !== 0) continue;
        chosenEmpty = empty;
        chosenCoParent = coParent;
      }

      if (chosenEmpty >= 0) {
        const parent1Share = cappedEnergy * 0.25;
        const rawParent2Energy = bEnergy[chosenCoParent];
        const parent2Energy = rawParent2Energy > 0 ? rawParent2Energy : 0;
        const parent2Share = parent2Energy * 0.25;

        bType[chosenEmpty] = plantType;
        bBiomass[chosenEmpty] = childBiomass;
        bEnergy[chosenEmpty] = parent1Share + parent2Share;

        const rawCoParentGene = aGene[chosenCoParent];
        const coParentGene = rawCoParentGene < 0 ? 0 : rawCoParentGene > 1 ? 1 : rawCoParentGene;
        const parentPickRoll = rng();
        const parentGene = parentPickRoll < 0.5 ? gene : coParentGene;
        const mutationRoll = rng();
        const childGeneRaw = parentGene + (mutationRoll * 2 - 1) * mutationStep;
        bGene[chosenEmpty] = childGeneRaw < 0 ? 0 : childGeneRaw > 1 ? 1 : childGeneRaw;

        bEnergy[i] = cappedEnergy - parent1Share;
        bEnergy[chosenCoParent] -= parent2Share;
      }
    }
  }
  world.front = b;
  world.back = a;
  world.stats.tick += 1;
  world.stats.sunlight = world.sunlight;
  return world.stats;
}

export function computeStats(world) {
  const { type, biomass, gene } = world.front;
  let totalBiomass = 0;
  let geneSum = 0;
  let plantCount = 0;
  for (let i = 0; i < world.size; i++) if (type[i] === CellType.PLANT) {
    totalBiomass += biomass[i];
    geneSum += gene[i];
    plantCount++;
  }
  world.stats.totalBiomass = totalBiomass;
  world.stats.plantCount = plantCount;
  world.stats.avgGene = plantCount ? geneSum / plantCount : 0;
  world.stats.sunlight = world.sunlight;
  return world.stats;
}
