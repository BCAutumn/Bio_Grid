#!/usr/bin/env node
/**
 * 运行 N tick 并导出结果 - 用于生成对齐测试的"黄金"结果
 *
 * 用法:
 *   node scripts/run_ticks_and_export.mjs [options]
 *
 * 选项:
 *   --input=PATH    输入快照文件路径 (必需)
 *   --ticks=N       要运行的 tick 数 (默认 10)
 *   --seed=N        RNG 种子 (默认 12345)
 *   --output=PATH   输出文件路径 (默认 stdout)
 */

import fs from 'fs';
import { createWorld, resetWorld } from '../src/sim/world.js';
import { tick, computeStats } from '../src/sim/tick.js';
import { CellType } from '../src/sim/shared.js';
import { createSFC32 } from '../src/sim/rng.js';

function parseArgs() {
  const args = {
    input: null,
    ticks: 10,
    seed: 12345,
    output: null,
  };

  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'input') args.input = value;
    else if (key === 'ticks') args.ticks = parseInt(value, 10);
    else if (key === 'seed') args.seed = parseInt(value, 10);
    else if (key === 'output') args.output = value;
  }

  return args;
}

function loadSnapshot(path) {
  const json = fs.readFileSync(path, 'utf-8');
  return JSON.parse(json);
}

function applySnapshot(world, snapshot) {
  world.time = snapshot.time || 0;
  world.day = snapshot.day || 0;
  world.sunlight = snapshot.sunlight || 0;
  world.wallCount = snapshot.wallCount || 0;

  if (snapshot.config) {
    Object.assign(world.config, snapshot.config);
  }

  const front = snapshot.front;
  if (front) {
    world.front.type.set(new Uint8Array(front.type));
    world.front.biomass.set(new Float32Array(front.biomass));
    world.front.energy.set(new Float32Array(front.energy));
    world.front.gene.set(new Float32Array(front.gene));
    world.front.age.set(new Float32Array(front.age));

    // 同步到 back
    world.back.type.set(world.front.type);
    world.back.biomass.set(world.front.biomass);
    world.back.energy.set(world.front.energy);
    world.back.gene.set(world.front.gene);
    world.back.age.set(world.front.age);
  }

  const terrain = snapshot.terrain;
  if (terrain) {
    world.terrain.light.set(new Float32Array(terrain.light));
    world.terrain.loss.set(new Float32Array(terrain.loss));
  }

  if (snapshot.stats) {
    Object.assign(world.stats, snapshot.stats);
  }
}

function exportSnapshot(world) {
  const { front, terrain, config } = world;
  return {
    width: world.width,
    height: world.height,
    time: world.time,
    day: world.day,
    sunlight: world.sunlight,
    wallCount: world.wallCount,
    config: { ...config },
    front: {
      type: Array.from(front.type),
      biomass: Array.from(front.biomass),
      energy: Array.from(front.energy),
      gene: Array.from(front.gene),
      age: Array.from(front.age),
    },
    terrain: {
      light: Array.from(terrain.light),
      loss: Array.from(terrain.loss),
    },
    stats: { ...world.stats },
  };
}

function main() {
  const args = parseArgs();

  if (!args.input) {
    console.error('Error: --input=PATH is required');
    process.exit(1);
  }

  console.error(`Loading snapshot from ${args.input}`);
  const inputSnapshot = loadSnapshot(args.input);

  const { width, height } = inputSnapshot;
  console.error(`Creating world ${width}x${height}`);

  // 创建世界并应用快照
  const world = createWorld(width, height, inputSnapshot.config || {});
  applySnapshot(world, inputSnapshot);

  // 创建可复现 RNG
  const rng = createSFC32(args.seed);

  const initialPlants = Array.from(world.front.type).filter(t => t === CellType.PLANT).length;
  console.error(`Initial plants: ${initialPlants}`);
  console.error(`Running ${args.ticks} ticks with seed=${args.seed}...`);

  // 运行 tick
  for (let t = 0; t < args.ticks; t++) {
    tick(world, rng);
    if ((t + 1) % 10 === 0 || t === args.ticks - 1) {
      const stats = computeStats(world);
      console.error(`  Tick ${t + 1}: plants=${stats.plantCount}, biomass=${stats.totalBiomass.toFixed(2)}`);
    }
  }

  // 导出结果
  const outputSnapshot = exportSnapshot(world);
  const json = JSON.stringify(outputSnapshot, null, 2);

  if (args.output) {
    fs.writeFileSync(args.output, json);
    console.error(`Result saved to ${args.output}`);
  } else {
    console.log(json);
  }

  const finalPlants = Array.from(world.front.type).filter(t => t === CellType.PLANT).length;
  console.error(`Final plants: ${finalPlants}`);
}

main();
