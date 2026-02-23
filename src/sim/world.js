import { DEFAULT_CONFIG } from '../config.js';
import { buildNeighborCache, createGrid, toIndex, writeBoth } from './shared.js';

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

export function setCell(world, x, y, patch) {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return;
  writeBoth(world, toIndex(world, x, y), patch);
}

export function resetWorld(world) {
  for (const grid of [world.front, world.back]) {
    grid.type.fill(0);
    grid.biomass.fill(0);
    grid.energy.fill(0);
    grid.gene.fill(0);
    grid.age.fill(0);
  }
  world.time = 0;
  world.sunlight = 0;
  world.wallCount = 0;
  world.stats = { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, sunlight: 0 };
}

