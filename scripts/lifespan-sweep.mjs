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
  let plants = 0;
  let g0 = 0;
  let g1 = 0;
  for (let i = 0; i < world.size; i++) {
    if (type[i] !== CellType.PLANT) continue;
    if (biomass[i] <= 0) continue;
    plants++;
    if (gene[i] < 0.5) g0++;
    else g1++;
  }
  return { plants, g0, g1 };
}

function seedMixed(world, rng, nPerGene = 120) {
  const { width } = world;
  const used = new Uint8Array(world.size);
  const childB = world.config.childBiomass ?? 0.32;

  const placeOne = (geneVal) => {
    const mE = (world.config.energyMaxBase ?? 72) - geneVal * (world.config.energyMaxGeneRange ?? 36);
    const E0 = Math.max(0, Math.min(mE, mE * 0.5));
    for (let tries = 0; tries < 20000; tries++) {
      const i = (rng() * world.size) | 0;
      if (used[i]) continue;
      used[i] = 1;
      const x = i % width;
      const y = (i / width) | 0;
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
  ageMaxGeneRange,
  nPerGene,
}) {
  const rng = lcg(seed);
  const config = {
    sunSpeed,
    mutationStep: 0,
    mutationDistanceFactor: 0,
    ageMaxGeneRange,
    terrainClampLightMin: 0,
    terrainClampLightMax: terrainLightMax,
    terrainClampLossMin: 1,
    terrainClampLossMax: terrainLossMax,
  };
  const world = createWorld(40, 40, config);
  loadPreset(world, preset, rng);
  seedMixed(world, rng, nPerGene);
  for (let i = 0; i < steps; i++) tick(world, rng);
  return countByGene(world);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function runGrid({
  steps,
  preset,
  sunSpeed,
  terrainLightMax,
  terrainLossMax,
  ageRanges,
  reps,
  nPerGene,
}) {
  console.log(`\n=== preset=${preset} sunSpeed=${sunSpeed} lightMax=${terrainLightMax} lossMax=${terrainLossMax} steps=${steps} ===`);
  console.log(`ageMaxGeneRange sweep: [${ageRanges.join(', ')}], reps=${reps}, nPerGene=${nPerGene} (Gene=0 vs Gene=1, mutation off)`);
  console.log('range | avgPlants | g0% | g1% | winner');
  console.log('------|----------|-----|-----|--------');

  for (const r of ageRanges) {
    const outs = [];
    for (let k = 0; k < reps; k++) {
      outs.push(simulateOnce({
        seed: 2026 + k * 99991,
        steps,
        preset,
        sunSpeed,
        terrainLightMax,
        terrainLossMax,
        ageMaxGeneRange: r,
        nPerGene,
      }));
    }
    const avgPlants = mean(outs.map(o => o.plants));
    const avgG0 = mean(outs.map(o => o.g0));
    const avgG1 = mean(outs.map(o => o.g1));
    const frac0 = avgPlants ? avgG0 / avgPlants : 0;
    const frac1 = avgPlants ? avgG1 / avgPlants : 0;
    const winner = frac0 > frac1 ? '保守偏多' : (frac1 > frac0 ? '激进偏多' : '平手');
    console.log(
      `${String(r).padStart(5)} | ${avgPlants.toFixed(1).padStart(8)} | ${(frac0 * 100).toFixed(1).padStart(3)} | ${(frac1 * 100).toFixed(1).padStart(3)} | ${winner}`
    );
  }
}

const steps = 30000; // 与前面 balance-check 对齐（大约 3.34 天@默认sunSpeed）
const preset = 'verticalGradient';
const reps = 6;
const nPerGene = 120;
const ageRanges = [1.5, 2.5, 3.5, 5, 7];

const configs = [
  { sunSpeed: 0.014, terrainLightMax: 2, terrainLossMax: 25 },
  { sunSpeed: 0.08, terrainLightMax: 2, terrainLossMax: 25 },
  { sunSpeed: 0.014, terrainLightMax: 1, terrainLossMax: 13 },
  { sunSpeed: 0.08, terrainLightMax: 1, terrainLossMax: 13 },
];

for (const c of configs) {
  runGrid({ steps, preset, reps, nPerGene, ageRanges, ...c });
}

