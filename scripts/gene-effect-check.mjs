import { createWorld, setCell } from '../src/sim/world.js';
import { loadPreset } from '../src/sim/presets.js';
import { tick } from '../src/sim/tick.js';
import { CellType } from '../src/sim/shared.js';

function lcg(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function uniformTerrain(world, light = 1, loss = 1) {
  world.terrain.light.fill(light);
  world.terrain.loss.fill(loss);
  world.terrain.lightMin = light;
  world.terrain.lightMax = light;
  world.terrain.lossMin = loss;
  world.terrain.lossMax = loss;
}

function countG01(world) {
  const { type, biomass, gene } = world.front;
  let g0 = 0;
  let g1 = 0;
  for (let i = 0; i < world.size; i++) {
    if (type[i] !== CellType.PLANT) continue;
    if (biomass[i] <= 0) continue;
    if (gene[i] < 0.5) g0++;
    else g1++;
  }
  return { g0, g1, plants: g0 + g1 };
}

function seedRandom(world, rng, occupancy = 0.25) {
  const childB = world.config.childBiomass ?? 0.32;
  const used = new Uint8Array(world.size);
  const want = Math.floor(world.size * occupancy);
  let placed = 0;

  const placeOne = (geneVal, i) => {
    const width = world.width;
    const x = i % width;
    const y = (i / width) | 0;
    const mE = (world.config.energyMaxBase ?? 72) - geneVal * (world.config.energyMaxGeneRange ?? 36);
    const E0 = Math.max(0, Math.min(mE, mE * 0.5));
    setCell(world, x, y, { type: CellType.PLANT, biomass: childB, energy: E0, gene: geneVal, age: 0 });
  };

  // 随机挑格子，Gene=0 与 Gene=1 各一半（精确到 1 的误差以内）
  const half = (want / 2) | 0;
  while (placed < want) {
    const i = (rng() * world.size) | 0;
    if (used[i]) continue;
    used[i] = 1;
    const geneVal = placed < half ? 0 : 1;
    placeOne(geneVal, i);
    placed++;
  }
}

function lnRatio(g1, g0) {
  // 加 0.5 做平滑，避免 0
  return Math.log((g1 + 0.5) / (g0 + 0.5));
}

function fitSlope(xs, ys) {
  // 简单最小二乘：y = a + b x
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sxy - sx * sy) / denom;
}

function simulateOnce({
  seed,
  width,
  height,
  sunSpeed,
  steps,
  sampleEvery,
  terrainMode, // 'uniform' | 'noise' | 'verticalGradient'
  terrainLightMax,
  terrainLossMax,
  transportMode, // 'full' | 'noOverflow' | 'noOsmosis' | 'noDiffusion' | 'noTransport'
}) {
  const rng = lcg(seed);

  const baseConfig = {
    sunSpeed,
    mutationStep: 0,
    mutationDistanceFactor: 0,
    // 让“噪声地形”更接近你说的标准光照：light ∈ [0, 1]
    terrainNoiseLightMin: 0,
    terrainNoiseLightMax: terrainLightMax,
    terrainNoiseLossMin: 1,
    terrainNoiseLossMax: terrainLossMax,
    terrainClampLightMin: 0,
    terrainClampLightMax: terrainLightMax,
    terrainClampLossMin: 1,
    terrainClampLossMax: terrainLossMax,
  };

  const transportTweaks = (() => {
    if (transportMode === 'full') return {};
    if (transportMode === 'noOverflow') return { overflowShareFrac: 0 };
    if (transportMode === 'noOsmosis') return { osmosisNeighbor: 0, osmosisSelf: 1 };
    if (transportMode === 'noDiffusion') return { diffuseNeighbor: 0, diffuseSelf: 1 };
    if (transportMode === 'noTransport') return {
      overflowShareFrac: 0,
      osmosisNeighbor: 0, osmosisSelf: 1,
      diffuseNeighbor: 0, diffuseSelf: 1
    };
    return {};
  })();

  const world = createWorld(width, height, { ...baseConfig, ...transportTweaks });

  // 地形选择
  if (terrainMode === 'uniform') {
    loadPreset(world, 'empty', rng);
    uniformTerrain(world, 1, 1);
  } else if (terrainMode === 'verticalGradient') {
    loadPreset(world, 'verticalGradient', rng);
  } else {
    // noise：createWorld 时已生成噪声地形；这里只清空格子
    loadPreset(world, 'empty', rng);
  }

  seedRandom(world, rng, 0.25);

  const xs = [];
  const ys = [];
  const snapshots = [];

  for (let t = 0; t < steps; t++) {
    tick(world, rng);
    if ((t + 1) % sampleEvery === 0) {
      const c = countG01(world);
      const x = (t + 1);
      const y = lnRatio(c.g1, c.g0);
      xs.push(x);
      ys.push(y);
      snapshots.push({ t: t + 1, ...c, lnR: y });
    }
  }

  const slopePerTick = fitSlope(xs, ys);
  // 转换成“每 1 天”的选择强度（ln 比值变化/天）
  const ticksPerDay = (2 * Math.PI / sunSpeed) / (world.config.timeStep ?? 0.05);
  const slopePerDay = slopePerTick * ticksPerDay;
  const final = snapshots.length ? snapshots[snapshots.length - 1] : { ...countG01(world), t: steps, lnR: lnRatio(0, 0) };
  return { final, slopePerDay, snapshots };
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function runScenario(name, params, reps = 5) {
  const outs = [];
  for (let r = 0; r < reps; r++) {
    outs.push(simulateOnce({ seed: 9001 + r * 1013, ...params }));
  }
  const plants = outs.map(o => o.final.plants);
  const frac1 = outs.map(o => (o.final.plants ? o.final.g1 / o.final.plants : 0));
  const slope = outs.map(o => o.slopePerDay);
  const avgPlants = mean(plants);
  const avgFrac1 = mean(frac1);
  const avgSlope = mean(slope);
  const winner = avgFrac1 > 0.5 ? '激进偏多' : (avgFrac1 < 0.5 ? '保守偏多' : '平手');
  console.log(`\n=== ${name} ===`);
  console.log(`params: ${JSON.stringify(params)}`);
  console.log(`avg plants=${avgPlants.toFixed(1)}, avg frac(G1)=${(avgFrac1 * 100).toFixed(1)}% -> ${winner}`);
  console.log(`selection strength ~ d ln(G1/G0) / day = ${avgSlope.toFixed(3)} (正=偏向激进, 负=偏向保守, 绝对值越大选择越强)`);
}

const common = {
  width: 40,
  height: 40,
  steps: 12000,
  sampleEvery: 400,
  terrainLossMax: 13,
  terrainLightMax: 1,
};

const sunSpeeds = [0.014, 0.08];
const terrains = ['uniform', 'noise', 'verticalGradient'];
// 只保留最能解释“差异被抹平”的对照组：全开 vs 全关 + 关绝对扩散
const transports = ['full', 'noDiffusion', 'noTransport'];

for (const sunSpeed of sunSpeeds) {
  for (const terrainMode of terrains) {
    for (const transportMode of transports) {
      runScenario(
        `sunSpeed=${sunSpeed} terrain=${terrainMode} transport=${transportMode}`,
        { ...common, sunSpeed, terrainMode, transportMode },
        3
      );
    }
  }
}

