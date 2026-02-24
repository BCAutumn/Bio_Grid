import { createWorld, setCell } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import { CellType } from '../src/sim/shared.js';

function lcg(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeWalledBox(world) {
  // 全墙，然后只开 3 个格：两亲本（彼此相邻）+ 唯一目标空地（同时邻接两亲本）
  const { width, height } = world;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    setCell(world, x, y, { type: CellType.WALL, biomass: 0, energy: 0, gene: 0, age: 0 });
  }
  const cx = (width / 2) | 0;
  const cy = (height / 2) | 0;
  // 两亲本：left & up（对角相邻）
  setCell(world, cx - 1, cy, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
  setCell(world, cx, cy - 1, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
  // 目标空地：center（同时邻接 left/up）
  setCell(world, cx, cy, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });
  // 更新 wallCount（world.resetWorld 不会自动维护）
  let wallCount = 0;
  for (let i = 0; i < world.size; i++) if (world.front.type[i] === CellType.WALL) wallCount++;
  world.wallCount = wallCount;
  return { cx, cy };
}

function uniformTerrain(world, light = 1, loss = 1) {
  world.terrain.light.fill(light);
  world.terrain.loss.fill(loss);
  world.terrain.lightMin = light;
  world.terrain.lightMax = light;
  world.terrain.lossMin = loss;
  world.terrain.lossMax = loss;
}

function capEnergy(world, gene) {
  const base = world.config.energyMaxBase ?? 72;
  const range = world.config.energyMaxGeneRange ?? 36;
  return base - gene * range;
}

function capBiomass(world, gene) {
  const base = world.config.biomassMaxBase ?? 1.8;
  const range = world.config.biomassMaxGeneRange ?? 0.8;
  return base - gene * range;
}

function isReproEligible(world, i) {
  const cfg = world.config;
  const gene = world.front.gene[i];
  const age = world.front.age[i] || 0;
  const E = world.front.energy[i];
  const B = world.front.biomass[i];
  const maxE = capEnergy(world, gene);
  const maxB = capBiomass(world, gene);
  const maxAge = (cfg.ageMaxBase ?? 3) + (1 - gene) * (cfg.ageMaxGeneRange ?? 1.5);
  return (
    B > maxB * (cfg.reproBiomassRatio ?? 0.5) &&
    E > maxE * (cfg.reproEnergyRatio ?? 0.2) &&
    age <= maxAge * (cfg.senescenceStartFrac ?? 0.7)
  );
}

function runOne({ childBiomass, gene, sunSpeed = 0.014, maxTicks = 2000 }) {
  const rng = lcg(123);
  const world = createWorld(9, 9, {
    sunSpeed,
    childBiomass,
    mutationStep: 0,
    mutationDistanceFactor: 0,
  });
  uniformTerrain(world, 1, 1);
  const { cx, cy } = makeWalledBox(world);

  // 两个亲本放在 target empty 的左右；target 在中心
  const parentB = capBiomass(world, gene);
  const parentE = capEnergy(world, gene);
  setCell(world, cx - 1, cy, { type: CellType.PLANT, biomass: parentB, energy: parentE, gene, age: 0 });
  setCell(world, cx, cy - 1, { type: CellType.PLANT, biomass: parentB, energy: parentE, gene, age: 0 });
  // target empty
  setCell(world, cx, cy, { type: CellType.EMPTY, biomass: 0, energy: 0, gene: 0, age: 0 });

  const targetIdx = cy * world.width + cx;
  const parentIdxA = cy * world.width + (cx - 1);
  const parentIdxB = (cy - 1) * world.width + cx;

  // 跑到发生繁殖：target 变成 PLANT
  let bornAt = null;
  for (let t = 0; t < 200; t++) {
    tick(world, rng);
    if (world.front.type[targetIdx] === CellType.PLANT) {
      bornAt = t + 1;
      break;
    }
  }
  if (bornAt == null) {
    // 兜底：如果 RNG/实现导致没在 target 生，找“除了亲本之外的第一个新植物”
    for (let i = 0; i < world.size; i++) {
      if (i === parentIdxA || i === parentIdxB) continue;
      if (world.front.type[i] === CellType.PLANT && world.front.biomass[i] > 0) {
        return { bornAt: 'unknown', matureAt: null, ticksToMature: null };
      }
    }
    return { bornAt: null, matureAt: null, ticksToMature: null };
  }

  // 从出生后开始计数，到可繁殖（reproEligible 条件）为止
  let matureAt = null;
  for (let t = bornAt; t < maxTicks; t++) {
    // 出生那一刻之后的状态也要算，所以先检查再 tick
    if (isReproEligible(world, targetIdx)) {
      matureAt = t;
      break;
    }
    tick(world, rng);
  }
  if (matureAt == null) return { bornAt, matureAt: null, ticksToMature: null };
  return { bornAt, matureAt, ticksToMature: matureAt - bornAt };
}

const childVals = [0.12, 0.16, 0.20, 0.24, 0.28, 0.32, 0.36, 0.40];
for (const gene of [0, 1]) {
  console.log(`\n=== Gene=${gene} (maxB=${gene === 0 ? 1.8 : 1.0}, reproB=${gene === 0 ? 0.9 : 0.5}) ===`);
  console.log('childB | bornAt | ticksToMature');
  console.log('-------|--------|-------------');
  for (const childBiomass of childVals) {
    const out = runOne({ childBiomass, gene, sunSpeed: 0.014, maxTicks: 5000 });
    const born = out.bornAt == null ? 'N/A' : String(out.bornAt);
    const mature = out.ticksToMature == null ? 'N/A' : String(out.ticksToMature);
    console.log(`${childBiomass.toFixed(2).padStart(6)} | ${born.padStart(6)} | ${mature.padStart(11)}`);
  }
}
