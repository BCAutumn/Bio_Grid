import { DEFAULT_CONFIG } from '../config.js';
import { buildNeighborCache, createGrid, toIndex, writeBoth } from './shared.js';

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

function fbm2d(x, y, seed, octaves) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let ampTotal = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise2d(x * freq, y * freq, seed + octave * 17.0) * amp;
    ampTotal += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return ampTotal > 0 ? sum / ampTotal : 0;
}

function normalLikeFbm2d(x, y, seed, octaves, samples) {
  const k = Math.max(1, samples | 0);
  if (k === 1) return fbm2d(x, y, seed, octaves);
  let sum = 0;
  for (let s = 0; s < k; s++) {
    // 通过 seed 与坐标偏移做 decorrelate；平均后分布会更“钟形”，极端概率更低。
    const sx = x + s * 13.17;
    const sy = y - s * 7.73;
    sum += fbm2d(sx, sy, seed + s * 101.33, octaves);
  }
  return sum / k;
}

function scanMinMax(arr) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

export function recomputeTerrainRanges(world) {
  const terrain = world?.terrain;
  if (!terrain) return;
  const lightMM = scanMinMax(terrain.light);
  const lossMM = scanMinMax(terrain.loss);
  terrain.lightMin = lightMM.min;
  terrain.lightMax = lightMM.max;
  terrain.lossMin = lossMM.min;
  terrain.lossMax = lossMM.max;
}

function buildTerrain(width, height, config) {
  const size = width * height;
  const light = new Float32Array(size);
  const loss = new Float32Array(size);
  const safeW = width > 1 ? width - 1 : 1;
  const safeH = height > 1 ? height - 1 : 1;
  const baseFreq = Number.isFinite(config.terrainBaseFreq) ? config.terrainBaseFreq : 4.8;
  const octaves = Math.max(1, (config.terrainOctaves | 0) || 4);
  const lightMin = Number.isFinite(config.terrainNoiseLightMin) ? config.terrainNoiseLightMin : 0;
  const lightMax = Number.isFinite(config.terrainNoiseLightMax) ? config.terrainNoiseLightMax : 2;
  const lossMin = Number.isFinite(config.terrainNoiseLossMin) ? config.terrainNoiseLossMin : 1;
  const lossMax = Number.isFinite(config.terrainNoiseLossMax) ? config.terrainNoiseLossMax : 13;
  const seedLight = Number.isFinite(config.terrainSeedLight) ? config.terrainSeedLight : 11.37;
  const seedLoss = Number.isFinite(config.terrainSeedLoss) ? config.terrainSeedLoss : 73.91;
  const offX = Number.isFinite(config.terrainOffsetX) ? config.terrainOffsetX : 19.3;
  const offY = Number.isFinite(config.terrainOffsetY) ? config.terrainOffsetY : -7.1;
  const dist = config.terrainNoiseDistribution || 'flat';
  const normalSamples = Math.max(1, (config.terrainNoiseNormalSamples | 0) || 1);
  const sample = dist === 'normal'
    ? (x, y, seed) => normalLikeFbm2d(x, y, seed, octaves, normalSamples)
    : (x, y, seed) => fbm2d(x, y, seed, octaves);

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const nx = x / safeW;
    const ny = y / safeH;
    const lightNoise = sample(nx * baseFreq, ny * baseFreq, seedLight);
    const lossNoise = sample((nx + offX) * baseFreq, (ny + offY) * baseFreq, seedLoss);
    light[i] = lerp(lightMin, lightMax, lightNoise);
    loss[i] = lerp(lossMin, lossMax, lossNoise);
  }

  const terrain = {
    light,
    loss,
    // UI/笔刷 clamp 用 config；显示归一化范围会在下方 recomputeTerrainRanges 里按实际地形扫描。
    lightClampMin: Number.isFinite(config.terrainClampLightMin) ? config.terrainClampLightMin : 0,
    lightClampMax: Number.isFinite(config.terrainClampLightMax) ? config.terrainClampLightMax : 2,
    lossClampMin: Number.isFinite(config.terrainClampLossMin) ? config.terrainClampLossMin : 1,
    lossClampMax: Number.isFinite(config.terrainClampLossMax) ? config.terrainClampLossMax : 25,
    lightMin: 0,
    lightMax: 0,
    lossMin: 0,
    lossMax: 0
  };
  // 初始化时自动扫描实际范围，避免“写死 0~6/0~2”导致显示归一化不准确。
  const tmpWorld = { terrain };
  recomputeTerrainRanges(tmpWorld);
  return terrain;
}

export function createWorld(width = 160, height = 160, config = {}) {
  const size = width * height;
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  return {
    width,
    height,
    size,
    time: 0,
    day: 0,
    sunlight: 0,
    config: mergedConfig,
    extensions: { typeUpdaters: {} },
    neighbors: buildNeighborCache(width, height),
    terrain: buildTerrain(width, height, mergedConfig),
    wallCount: 0,
    // 用于“能量传输视图”的调试/可视化数据（每 Tick 由 tick() 重置并写入）。
    // - in/out: 本 Tick 内从邻居收到/向邻居送出的能量总量
    // - vx/vy: 本 Tick 内向外送出能量的方向向量（用于画箭头）
    flow: {
      in: new Float32Array(size),
      out: new Float32Array(size),
      vx: new Float32Array(size),
      vy: new Float32Array(size)
    },
    scratch: {
      reproEligible: new Uint8Array(size),
      overflowOut: new Float32Array(size),
      overflowIn: new Float32Array(size)
    },
    front: createGrid(size),
    back: createGrid(size),
    stats: { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, normalizedBiomass: 0, senescentRatio: 0, sunlight: 0 }
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
  world.day = 0;
  world.sunlight = 0;
  world.wallCount = 0;
  world.stats = { tick: 0, totalBiomass: 0, avgGene: 0, plantCount: 0, normalizedBiomass: 0, senescentRatio: 0, sunlight: 0 };
}
