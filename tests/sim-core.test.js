import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CellType,
  createWorld,
  setCell,
  tick
} from '../src/sim/index.js';

const approx = (actual, expected, eps = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= eps, `Expected ${actual} ≈ ${expected}`);
};

const neutralTerrain = (world) => {
  if (world.terrain?.light) world.terrain.light.fill(1);
  if (world.terrain?.loss) world.terrain.loss.fill(1);
};

test('energy in empty cell does not diffuse', () => {
  const world = createWorld(3, 3, { baseCost: 0, geneCostFactor: 0, growthRate: 0, decayRate: 0, sunSpeed: 0 });
  neutralTerrain(world);
  setCell(world, 1, 1, { energy: 100, type: CellType.EMPTY });

  tick(world, () => 0.5);

  const center = world.front.energy[1 + 1 * world.width];
  const right = world.front.energy[2 + 1 * world.width];
  approx(center, 100);
  approx(right, 0);
});

test('energy diffuses among living plants and smooths spikes', () => {
  const world = createWorld(3, 1, {
    sunSpeed: 0,
    diffuseSelf: 0.5,
    diffuseNeighbor: 0.5,
    diffuseGradientThreshold: 0,
    diffuseGradientScale: 1,
    baseCost: 0,
    geneCostFactor: 0,
    growthRate: 0,
    decayRate: 0,
    isolationEnergyLoss: 0,
    maxEnergy: 1000
  });
  neutralTerrain(world);
  setCell(world, 0, 0, { type: CellType.PLANT, biomass: 1, energy: 100, gene: 0.5 });
  setCell(world, 1, 0, { type: CellType.PLANT, biomass: 1, energy: 0, gene: 0.5 });
  setCell(world, 2, 0, { type: CellType.PLANT, biomass: 1, energy: 0, gene: 0.5 });

  tick(world, () => 0.5);

  // 3x1 的边界格子只有 1 个邻居：扩散后各得 50，但 Gene=0.5 时 maxEnergy=56，未超上限
  approx(world.front.energy[0], 50);
  approx(world.front.energy[1], 50);
  approx(world.front.energy[2], 0);
});

test('wall cells block diffusion and keep zero energy', () => {
  const world = createWorld(3, 1, { baseCost: 0, geneCostFactor: 0, growthRate: 0, decayRate: 0, sunSpeed: 0 });
  neutralTerrain(world);
  setCell(world, 0, 0, { energy: 100, type: CellType.EMPTY });
  setCell(world, 1, 0, { type: CellType.WALL });

  tick(world, () => 0.5);

  const right = world.front.energy[2];
  const wall = world.front.energy[1];
  approx(right, 0);
  approx(wall, 0);
});

test('plant dies when sustained energy deficit empties biomass', () => {
  const world = createWorld(1, 1, {
    sunSpeed: 0,
    diffuseSelf: 1,
    diffuseNeighbor: 0,
    baseCost: 1,
    geneCostFactor: 0,
    growthRate: 0.05,
    decayRate: 0.1,
    isolationEnergyLoss: 0
  });
  neutralTerrain(world);
  setCell(world, 0, 0, { type: CellType.PLANT, biomass: 0.05, energy: 0, gene: 1 });

  tick(world, () => 0.5);

  assert.equal(world.front.type[0], CellType.EMPTY);
  approx(world.front.biomass[0], 0);
});

test('mature plant reproduces and mutation stays clamped', () => {
  const world = createWorld(3, 3, {
    sunSpeed: 0,
    diffuseSelf: 1,
    diffuseNeighbor: 0,
    baseCost: 0,
    geneCostFactor: 0,
    reproBiomassRatio: 0.5,
    reproEnergyRatio: 0.1,
    mutationStep: 0.05,
    childBiomass: 0.4,
    isolationEnergyLoss: 0
  });
  neutralTerrain(world);
  setCell(world, 1, 1, { type: CellType.PLANT, biomass: 1.2, energy: 20, gene: 0.5 });
  setCell(world, 0, 1, { type: CellType.PLANT, biomass: 1.2, energy: 20, gene: 0.5 });

  tick(world, () => 0);

  const plants = [];
  for (let i = 0; i < world.size; i++) if (world.front.type[i] === CellType.PLANT) plants.push(i);
  assert.ok(plants.length >= 3);

  const children = plants.filter((i) => i !== 4 && i !== 3);
  const energies = children.map(i => world.front.energy[i]).sort((a, b) => b - a);
  approx(energies[0], 10);
  if (energies.length > 1) {
    approx(energies[1], 7.5);
  }
});

test('overcrowding causes apoptosis in dense neighborhoods', () => {
  const world = createWorld(3, 3, {
    sunSpeed: 0,
    diffuseSelf: 1,
    diffuseNeighbor: 0,
    baseCost: 0,
    geneCostFactor: 0,
    growthRate: 0,
    decayRate: 1.0,
    crowdNeighborSoft: 2,
    crowdEnergyLoss: 2.0,
    maxEnergy: 100
  });
  neutralTerrain(world);

  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    setCell(world, x, y, { type: CellType.PLANT, biomass: 1, energy: 1, gene: 0.4 });
  }

  tick(world, () => 0.5);

  assert.equal(world.front.type[4], CellType.EMPTY);
  approx(world.front.biomass[4], 0);
});

test('terrain directly scales sunlight and baseCost', () => {
  const world = createWorld(1, 1, {
    timeStep: Math.PI / 2,
    sunSpeed: 1,
    diffuseSelf: 1,
    diffuseNeighbor: 0,
    baseCost: 1,
    geneCostFactor: 2,
    growthRate: 0,
    decayRate: 0,
    isolationEnergyLoss: 0
  });
  setCell(world, 0, 0, { type: CellType.PLANT, biomass: 1, energy: 0, gene: 1 });
  world.terrain.light[0] = 0.5;
  world.terrain.loss[0] = 2;

  tick(world, () => 0.5);

  // sunlight=1 -> localSunlight=0.5
  // income=0.5*(0.04+1*0.0056)=0.0228
  // cost0=1*2 + 1^2*2 = 4（地形只乘 baseCost，不乘 geneCostFactor）
  approx(world.front.energy[0], -3.9772);
});
