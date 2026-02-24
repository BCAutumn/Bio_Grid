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

function countByGene(world) {
  const { type, gene, biomass } = world.front;
  let g0 = 0;
  let g1 = 0;
  let other = 0;
  let plants = 0;
  for (let i = 0; i < world.size; i++) {
    if (type[i] !== CellType.PLANT) continue;
    if (biomass[i] <= 0) continue;
    plants++;
    const g = gene[i];
    if (g < 0.5) g0++;
    else if (g >= 0.5) g1++;
    else other++;
  }
  return { plants, g0, g1, other };
}

function seedMixed(world, rng, nPerGene = 120, genes = [0, 1]) {
  const { width, height } = world;
  const used = new Uint8Array(world.size);
  const childB = world.config.childBiomass ?? 0.32;

  function placeOne(geneVal) {
    const mE = (world.config.energyMaxBase ?? 72) - geneVal * (world.config.energyMaxGeneRange ?? 36);
    const E0 = Math.max(0, Math.min(mE, mE * 0.5));
    for (let tries = 0; tries < 10000; tries++) {
      const x = (rng() * width) | 0;
      const y = (rng() * height) | 0;
      const i = y * width + x;
      if (used[i]) continue;
      used[i] = 1;
      setCell(world, x, y, {
        type: CellType.PLANT,
        biomass: childB,
        energy: E0,
        gene: geneVal,
        age: 0,
      });
      return true;
    }
    return false;
  }

  for (const g of genes) {
    for (let k = 0; k < nPerGene; k++) {
      if (!placeOne(g)) break;
    }
  }
}

function simulateOnce({
  seed,
  sunSpeed,
  steps,
  preset,
  terrainLightMax,
  terrainLossMax,
  nPerGene,
}) {
  const rng = lcg(seed);

  const config = {
    sunSpeed,
    mutationStep: 0,
    mutationDistanceFactor: 0,
    // 为了贴近你的描述：让预设用 clamp 值决定范围
    terrainClampLightMin: 0,
    terrainClampLightMax: terrainLightMax,
    terrainClampLossMin: 1,
    terrainClampLossMax: terrainLossMax,
  };

  const world = createWorld(40, 40, config);
  loadPreset(world, preset, rng);
  seedMixed(world, rng, nPerGene, [0, 1]);

  // 预热少量 tick，避免初始相位偏差（可选）
  for (let i = 0; i < 20; i++) tick(world, rng);

  let snapshot = null;
  const sampleEvery = 2000;
  for (let t = 0; t < steps; t++) {
    tick(world, rng);
    if ((t + 1) % sampleEvery === 0) snapshot = countByGene(world);
  }
  const final = countByGene(world);
  return { final, snapshot };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function runScenario(name, params, reps = 5) {
  const results = [];
  for (let r = 0; r < reps; r++) {
    const seed = 1337 + r * 9991;
    const out = simulateOnce({ seed, ...params });
    results.push(out.final);
  }
  const plants = results.map(x => x.plants);
  const g0 = results.map(x => x.g0);
  const g1 = results.map(x => x.g1);

  const total = mean(plants);
  const g0m = mean(g0);
  const g1m = mean(g1);
  const frac0 = total ? g0m / total : 0;
  const frac1 = total ? g1m / total : 0;

  const winner = frac0 > frac1 ? 'Gene<0.5(偏保守)' : (frac1 > frac0 ? 'Gene>=0.5(偏激进)' : '平手');

  console.log(`\n=== ${name} ===`);
  console.log(`config: ${JSON.stringify(params)}`);
  console.log(`avg plants=${total.toFixed(1)}, g0=${g0m.toFixed(1)} (${(frac0*100).toFixed(1)}%), g1=${g1m.toFixed(1)} (${(frac1*100).toFixed(1)}%) -> ${winner}`);
}

const steps = 30000; // ~3.34天(默认sunSpeed)
const base = {
  steps,
  preset: 'verticalGradient',
  nPerGene: 120,
};

const sunSpeeds = [0.004, 0.014, 0.08];

for (const terrainLightMax of [2, 1]) {
  for (const terrainLossMax of [25, 13]) {
    for (const sunSpeed of sunSpeeds) {
      runScenario(
        `verticalGradient | lightMax=${terrainLightMax} lossMax=${terrainLossMax} | sunSpeed=${sunSpeed}`,
        { ...base, terrainLightMax, terrainLossMax, sunSpeed },
        6
      );
    }
  }
}
