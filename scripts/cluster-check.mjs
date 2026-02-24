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

function uniformTerrain(world, light = 1, loss = 1) {
  world.terrain.light.fill(light);
  world.terrain.loss.fill(loss);
  world.terrain.lightMin = light;
  world.terrain.lightMax = light;
  world.terrain.lossMin = loss;
  world.terrain.lossMax = loss;
}

function countPlants(world) {
  const { type, biomass, gene } = world.front;
  let total = 0;
  let g0 = 0;
  let g1 = 0;
  for (let i = 0; i < world.size; i++) {
    if (type[i] !== CellType.PLANT) continue;
    if (biomass[i] <= 0) continue;
    total++;
    if (gene[i] < 0.5) g0++;
    else g1++;
  }
  return { total, g0, g1 };
}

function seedCluster(world, geneVal, shape) {
  const { width, height } = world;
  const cx = (width / 2) | 0;
  const cy = (height / 2) | 0;
  const childB = world.config.childBiomass ?? 0.32;
  const mE = (world.config.energyMaxBase ?? 72) - geneVal * (world.config.energyMaxGeneRange ?? 36);
  const E0 = Math.max(0, Math.min(mE, mE * 0.5));

  const coords = [];
  if (shape === 'L3') {
    coords.push([cx, cy], [cx + 1, cy], [cx, cy + 1]);
  } else if (shape === 'S4') {
    coords.push([cx, cy], [cx + 1, cy], [cx, cy + 1], [cx + 1, cy + 1]);
  } else if (shape === 'line3') {
    coords.push([cx - 1, cy], [cx, cy], [cx + 1, cy]);
  } else {
    throw new Error('unknown shape');
  }

  for (const [x, y] of coords) {
    setCell(world, x, y, { type: CellType.PLANT, biomass: childB, energy: E0, gene: geneVal, age: 0 });
  }
}

function run({ geneVal, sunSpeed, days, shape, light, loss }) {
  const rng = lcg(42);
  const world = createWorld(25, 25, {
    sunSpeed,
    mutationStep: 0,
    mutationDistanceFactor: 0,
  });
  uniformTerrain(world, light, loss);
  seedCluster(world, geneVal, shape);

  const ticksPerDay = (2 * Math.PI / sunSpeed) / world.config.timeStep;
  const steps = Math.ceil(days * ticksPerDay);

  let min = Infinity;
  let max = 0;
  let diedAt = null;

  const sampleEvery = Math.max(1, Math.floor(ticksPerDay / 4)); // 每 1/4 天采样
  for (let t = 0; t < steps; t++) {
    tick(world, rng);
    if ((t + 1) % sampleEvery === 0) {
      const c = countPlants(world).total;
      if (c < min) min = c;
      if (c > max) max = c;
      if (c === 0 && diedAt == null) diedAt = (t + 1) / ticksPerDay;
    }
  }

  const final = countPlants(world).total;
  return { final, min, max, diedAt };
}

const scenarios = [
  { sunSpeed: 0.004, label: '慢昼夜' },
  { sunSpeed: 0.014, label: '默认' },
  { sunSpeed: 0.08, label: '快昼夜' },
];

const shapes = ['L3', 'S4', 'line3'];
const genes = [
  { g: 0, name: '保守(G=0)' },
  { g: 1, name: '激进(G=1)' },
];

console.log('=== 最小团簇稳定性测试（目标：3-4个可稳定） ===');
console.log('地形：uniform light=1 loss=1；突变关闭；出生能量=0.5cap；出生生物量=childBiomass');

for (const sc of scenarios) {
  for (const shape of shapes) {
    for (const gg of genes) {
      const out = run({ geneVal: gg.g, sunSpeed: sc.sunSpeed, days: 8, shape, light: 1, loss: 1 });
      const status = out.final === 0 ? '灭绝' : '存活';
      console.log(`${sc.label} sunSpeed=${sc.sunSpeed} | shape=${shape} | ${gg.name} -> ${status}, final=${out.final}, min=${out.min}, max=${out.max}, diedAt=${out.diedAt?.toFixed(2) ?? '-'}d`);
    }
  }
}
