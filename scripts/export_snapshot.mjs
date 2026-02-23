#!/usr/bin/env node
/**
 * 快照导出工具 - 用于 Python 对齐测试
 *
 * 用法:
 *   node scripts/export_snapshot.mjs [options]
 *
 * 选项:
 *   --width=N       网格宽度 (默认 32)
 *   --height=N      网格高度 (默认 32)
 *   --seed=N        随机种子 (默认 12345)
 *   --plants=N      初始植物数量 (默认 width*height/10)
 *   --output=PATH   输出文件路径 (默认 stdout)
 */

import fs from 'fs';
import { createWorld, resetWorld } from '../src/sim/world.js';
import { CellType } from '../src/sim/shared.js';
import { createSFC32 } from '../src/sim/rng.js';

function parseArgs() {
  const args = {
    width: 32,
    height: 32,
    seed: 12345,
    plants: null,
    output: null,
  };

  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'width') args.width = parseInt(value, 10);
    else if (key === 'height') args.height = parseInt(value, 10);
    else if (key === 'seed') args.seed = parseInt(value, 10);
    else if (key === 'plants') args.plants = parseInt(value, 10);
    else if (key === 'output') args.output = value;
  }

  if (args.plants === null) {
    args.plants = Math.floor(args.width * args.height / 10);
  }

  return args;
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
  const { width, height, seed, plants } = args;

  console.error(`Creating world ${width}x${height} with seed=${seed}, plants=${plants}`);

  // 创建世界
  const world = createWorld(width, height);
  resetWorld(world);

  // 使用可复现 RNG 放置植物
  const rng = createSFC32(seed);

  for (let p = 0; p < plants; p++) {
    const x = Math.floor(rng() * width);
    const y = Math.floor(rng() * height);
    const i = y * width + x;

    // 跳过已有植物的位置
    if (world.front.type[i] !== CellType.EMPTY) {
      continue;
    }

    const gene = rng();
    const biomass = 0.5 + rng() * 0.5;
    const energy = 20 + rng() * 30;

    world.front.type[i] = CellType.PLANT;
    world.front.biomass[i] = biomass;
    world.front.energy[i] = energy;
    world.front.gene[i] = gene;
    world.front.age[i] = 0;

    world.back.type[i] = CellType.PLANT;
    world.back.biomass[i] = biomass;
    world.back.energy[i] = energy;
    world.back.gene[i] = gene;
    world.back.age[i] = 0;
  }

  // 设置简单地形（与 Python 测试一致）
  for (let i = 0; i < world.size; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    world.terrain.light[i] = 0.5 + (x / width);
    world.terrain.loss[i] = 1.0 + (y / height) * 5;
  }

  // 导出快照
  const snapshot = exportSnapshot(world);
  const json = JSON.stringify(snapshot, null, 2);

  if (args.output) {
    fs.writeFileSync(args.output, json);
    console.error(`Snapshot saved to ${args.output}`);
  } else {
    console.log(json);
  }

  const plantCount = Array.from(world.front.type).filter(t => t === CellType.PLANT).length;
  console.error(`Exported snapshot with ${plantCount} plants`);
}

main();
