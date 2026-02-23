import { DEFAULT_CONFIG } from '../config.js';
import { buildNeighborCache, createGrid, toIndex, writeBoth } from './shared.js';

const TERRAIN_LIGHT_MIN = 0.55;
const TERRAIN_LIGHT_MAX = 1.45;
const TERRAIN_LOSS_MIN = 0.6;
const TERRAIN_LOSS_MAX = 1.8;
const TERRAIN_BASE_FREQ = 4.8;
const TERRAIN_OCTAVES = 4;

const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function hash2d(x, y, seed) {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 91.9) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2d(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const u = smoothstep(tx);
  const v = smoothstep(ty);

  const v00 = hash2d(x0, y0, seed);
  const v10 = hash2d(x0 + 1, y0, seed);
  const v01 = hash2d(x0, y0 + 1, seed);
  const v11 = hash2d(x0 + 1, y0 + 1, seed);

  const i0 = lerp(v00, v10, u);
  const i1 = lerp(v01, v11, u);
  return lerp(i0, i1, v);
}

function fbm2d(x, y, seed) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let ampTotal = 0;
  for (let octave = 0; octave < TERRAIN_OCTAVES; octave++) {
    sum += valueNoise2d(x * freq, y * freq, seed + octave * 17.0) * amp;
    ampTotal += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return ampTotal > 0 ? sum / ampTotal : 0;
}

function buildTerrain(width, height) {
  const size = width * height;
  const light = new Float32Array(size);
  const loss = new Float32Array(size);
  const safeW = width > 1 ? width - 1 : 1;
  const safeH = height > 1 ? height - 1 : 1;

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const nx = x / safeW;
    const ny = y / safeH;
    const lightNoise = fbm2d(nx * TERRAIN_BASE_FREQ, ny * TERRAIN_BASE_FREQ, 11.37);
    const lossNoise = fbm2d((nx + 19.3) * TERRAIN_BASE_FREQ, (ny - 7.1) * TERRAIN_BASE_FREQ, 73.91);
    light[i] = lerp(TERRAIN_LIGHT_MIN, TERRAIN_LIGHT_MAX, lightNoise);
    loss[i] = lerp(TERRAIN_LOSS_MIN, TERRAIN_LOSS_MAX, lossNoise);
  }

  return {
    light,
    loss,
    lightMin: TERRAIN_LIGHT_MIN,
    lightMax: TERRAIN_LIGHT_MAX,
    lossMin: TERRAIN_LOSS_MIN,
    lossMax: TERRAIN_LOSS_MAX
  };
}

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
    terrain: buildTerrain(width, height),
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

