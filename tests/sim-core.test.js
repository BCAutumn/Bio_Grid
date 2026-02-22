import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CellType,
  createWorld,
  setCell,
  tick
} from '../src/sim-core.js';

const approx = (actual, expected, eps = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= eps, `Expected ${actual} ≈ ${expected}`);
};

test('energy diffusion smooths local spikes', () => {
  const world = createWorld(3, 3, { baseCost: 0, geneCostFactor: 0, growthRate: 0, decayRate: 0, sunSpeed: 0 });
  setCell(world, 1, 1, { energy: 100, type: CellType.EMPTY });

  tick(world, () => 0.5);

  const center = world.front.energy[1 + 1 * world.width];
  const right = world.front.energy[2 + 1 * world.width];
  approx(center, 80);
  assert.ok(right > 0);
});

test('wall cells block diffusion and keep zero energy', () => {
  const world = createWorld(3, 1, { baseCost: 0, geneCostFactor: 0, growthRate: 0, decayRate: 0, sunSpeed: 0 });
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
    reproBiomass: 0.9,
    reproEnergy: 10,
    mutationStep: 0.05,
    childBiomass: 0.4,
    isolationEnergyLoss: 0
  });
  setCell(world, 1, 1, { type: CellType.PLANT, biomass: 1, energy: 20, gene: 0.5 });
  setCell(world, 0, 1, { type: CellType.PLANT, biomass: 1, energy: 20, gene: 0.5 });

  tick(world, () => 1);

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

  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    setCell(world, x, y, { type: CellType.PLANT, biomass: 1, energy: 1, gene: 0.4 });
  }

  tick(world, () => 0.5);

  assert.equal(world.front.type[4], CellType.EMPTY);
  approx(world.front.biomass[4], 0);
});
