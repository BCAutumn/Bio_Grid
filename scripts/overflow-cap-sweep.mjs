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

function countG01(world) {
  const { type, biomass, gene } = world.front;
  let g0 = 0, g1 = 0;
  for (let i = 0; i < world.size; i++) {
    if (type[i] !== CellType.PLANT) continue;
    if (biomass[i] <= 0) continue;
    if (gene[i] < 0.5) g0++;
    else g1++;
  }
  const plants = g0 + g1;
  return { plants, g0, g1, frac1: plants ? g1 / plants : 0 };
}

function seedMixed(world, rng, nPerGene = 120) {
  const used = new Uint8Array(world.size);
  const childB = world.config.childBiomass ?? 0.32;
  const placeOne = (geneVal) => {
    const mE = (world.config.energyMaxBase ?? 72) - geneVal * (world.config.energyMaxGeneRange ?? 36);
    const E0 = Math.max(0, Math.min(mE, mE * 0.5));
    for (let tries = 0; tries < 20000; tries++) {
      const i = (rng() * world.size) | 0;
      if (used[i]) continue;
      used[i] = 1;
      const x = i % world.width;
      const y = (i / world.width) | 0;
      setCell(world, x, y, { type: CellType.PLANT, biomass: childB, energy: E0, gene: geneVal, age: 0 });
      return true;
    }
    return false;
  };
  for (let k = 0; k < nPerGene; k++) placeOne(0);
  for (let k = 0; k < nPerGene; k++) placeOne(1);
}

function simulateOnce({
  seed,
  steps,
  sunSpeed,
  preset,
  terrainLightMax,
  terrainLossMax,
  overflowShareFrac,
  energyMaxGeneRange,
  nPerGene,
}) {
  const rng = lcg(seed);
  const config = {
    sunSpeed,
    mutationStep: 0,
    mutationDistanceFactor: 0,
    overflowShareFrac,
    energyMaxGeneRange,
    terrainClampLightMin: 0,
    terrainClampLightMax: terrainLightMax,
    terrainClampLossMin: 1,
    terrainClampLossMax: terrainLossMax,
  };
  const world = createWorld(40, 40, config);
  loadPreset(world, preset, rng);
  seedMixed(world, rng, nPerGene);
  for (let t = 0; t < steps; t++) tick(world, rng);
  return countG01(world);
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function runScenario(label, params, reps = 4) {
  const outs = [];
  for (let r = 0; r < reps; r++) outs.push(simulateOnce({ seed: 42 + r * 10007, ...params }));
  const avgPlants = mean(outs.map(o => o.plants));
  const avgFrac1 = mean(outs.map(o => o.frac1));
  const winner = avgFrac1 > 0.55 ? '激进明显' : (avgFrac1 < 0.45 ? '保守明显' : '接近平衡');
  console.log(`${label} -> plants=${avgPlants.toFixed(1)}, frac(G1)=${(avgFrac1 * 100).toFixed(1)}% (${winner})`);
}

const steps = 20000;
const preset = 'verticalGradient';
const nPerGene = 120;

const sunSpeeds = [0.014, 0.08];
const lightMaxes = [1, 2];
const lossMax = 13;
const overflowFracs = [0, 0.1, 0.25, 0.5];
const capRanges = [12, 24, 36]; // 36=当前默认

for (const sunSpeed of sunSpeeds) {
  for (const terrainLightMax of lightMaxes) {
    console.log(`\n=== sunSpeed=${sunSpeed} verticalGradient lightMax=${terrainLightMax} lossMax=${lossMax} ===`);
    for (const energyMaxGeneRange of capRanges) {
      for (const overflowShareFrac of overflowFracs) {
        runScenario(
          `capRange=${String(energyMaxGeneRange).padStart(2)} overflow=${overflowShareFrac.toFixed(2)}`,
          { steps, preset, nPerGene, sunSpeed, terrainLightMax, terrainLossMax: lossMax, overflowShareFrac, energyMaxGeneRange },
          4
        );
      }
    }
  }
}

