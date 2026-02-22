import { CellType, createWorld, randomSeed, resetWorld, setCell, tick } from '../src/sim-core.js';

const parseArgs = (argv) => {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
};

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const randRange = (rng, lo, hi) => lo + (hi - lo) * rng();
const randChoice = (rng, arr) => arr[(rng() * arr.length) | 0];

const isAlivePlant = (type, biomass, i) => type[i] === CellType.PLANT && biomass[i] > 0;

const roundSig = (x, sig = 2) => {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const ax = Math.abs(x);
  const pow = Math.pow(10, sig - 1 - Math.floor(Math.log10(ax)));
  return Math.round(x * pow) / pow;
};

const roundConfigForCopy = (cfg) => {
  const rounded = { ...cfg };
  if (typeof cfg.diffuseNeighbor === 'number') {
    const dn = clamp(Math.round(cfg.diffuseNeighbor * 100) / 100, 0, 1);
    rounded.diffuseNeighbor = dn;
    rounded.diffuseSelf = 1 - dn;
  }
  for (const k of Object.keys(rounded)) {
    const v = rounded[k];
    if (k === 'diffuseNeighbor' || k === 'diffuseSelf') continue;
    if (typeof v !== 'number') continue;
    if (Number.isInteger(v)) continue;
    rounded[k] = roundSig(v, 2);
  }
  return rounded;
};

const computeLargestPlantComponent = (world) => {
  const { width, height, size, neighbors } = world;
  void height;
  const { indices, counts } = neighbors;
  const type = world.front.type;
  const biomass = world.front.biomass;

  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  let totalPlants = 0;
  for (let i = 0; i < size; i++) if (isAlivePlant(type, biomass, i)) totalPlants++;
  if (!totalPlants) return { totalPlants: 0, largest: 0, largestFrac: 0 };

  let largest = 0;
  for (let i = 0; i < size; i++) {
    if (visited[i]) continue;
    if (!isAlivePlant(type, biomass, i)) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    let comp = 0;
    while (head < tail) {
      const cur = queue[head++];
      comp++;
      const base = cur * 8;
      const deg = counts[cur];
      for (let n = 0; n < deg; n++) {
        const ni = indices[base + n];
        if (visited[ni]) continue;
        if (!isAlivePlant(type, biomass, ni)) continue;
        visited[ni] = 1;
        queue[tail++] = ni;
      }
    }
    if (comp > largest) largest = comp;
  }
  return { totalPlants, largest, largestFrac: largest / totalPlants, width };
};

const computePorosity = (world) => {
  const { width, height, size } = world;
  const type = world.front.type;
  const biomass = world.front.biomass;
  const isEmpty = (i) => !isAlivePlant(type, biomass, i);

  // 标记从边界“空气”可达的空地（4邻域）。
  const ext = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const pushIf = (i) => {
    if (i < 0 || i >= size) return;
    if (ext[i]) return;
    if (!isEmpty(i)) return;
    ext[i] = 1;
    queue[tail++] = i;
  };

  for (let x = 0; x < width; x++) {
    pushIf(x);
    pushIf((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    pushIf(y * width);
    pushIf(y * width + (width - 1));
  }

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) pushIf(i - 1);
    if (x + 1 < width) pushIf(i + 1);
    if (y > 0) pushIf(i - width);
    if (y + 1 < height) pushIf(i + width);
  }

  // 统计内部孔洞（不与外界连通的空地），并按组件计数。
  const seen = new Uint8Array(size);
  const holeQueue = new Int32Array(size);
  let internalEmpty = 0;
  let holeComponents = 0;
  let smallHoles = 0;
  let largeHoles = 0;

  for (let i = 0; i < size; i++) {
    if (ext[i]) continue;
    if (seen[i]) continue;
    if (!isEmpty(i)) continue;
    holeComponents++;
    let h = 0;
    let t = 0;
    holeQueue[t++] = i;
    seen[i] = 1;
    let holeSize = 0;
    while (h < t) {
      const cur = holeQueue[h++];
      holeSize++;
      const x = cur % width;
      const y = (cur / width) | 0;
      const tryPush = (ni) => {
        if (seen[ni] || ext[ni]) return;
        if (!isEmpty(ni)) return;
        seen[ni] = 1;
        holeQueue[t++] = ni;
      };
      if (x > 0) tryPush(cur - 1);
      if (x + 1 < width) tryPush(cur + 1);
      if (y > 0) tryPush(cur - width);
      if (y + 1 < height) tryPush(cur + width);
    }
    internalEmpty += holeSize;
    if (holeSize <= 2) smallHoles++;
    if (holeSize >= 10) largeHoles++;
  }

  const area = width * height;
  return {
    internalEmpty,
    internalEmptyRatio: internalEmpty / area,
    holeComponents,
    smallHoles,
    largeHoles,
    meanHoleSize: holeComponents ? internalEmpty / holeComponents : 0
  };
};

const scoreWorld = (world) => {
  const area = world.size;
  const comps = computeLargestPlantComponent(world);
  if (!comps.totalPlants) return { score: -1e9, metrics: { extinct: true } };

  const density = comps.totalPlants / area;
  const por = computePorosity(world);

  // 目标：连成片（largestFrac高）、有很多“小孔”、整体密度在合理区间。
  const densityTarget = 0.55;
  const densityScore = 40 - Math.abs(density - densityTarget) * 140; // 约 [-] 到 40
  const connectedScore = clamp(comps.largestFrac, 0, 1) * 55;

  const holeTarget = 0.08;
  const holeScore = 30 - Math.abs(por.internalEmptyRatio - holeTarget) * 180;
  const smallHoleBonus = clamp((por.smallHoles / area) * 1200, 0, 30);
  const largeHolePenalty = clamp(por.largeHoles * 1.5, 0, 25);

  // 防止太稀疏或太满。
  const sparsePenalty = density < 0.18 ? (0.18 - density) * 400 : 0;
  const fullPenalty = por.internalEmptyRatio < 0.01 ? (0.01 - por.internalEmptyRatio) * 800 : 0;

  const score = densityScore + connectedScore + holeScore + smallHoleBonus - largeHolePenalty - sparsePenalty - fullPenalty;
  return { score, metrics: { density, largestFrac: comps.largestFrac, ...por } };
};

const runTicks = (world, ticks, rng) => {
  for (let i = 0; i < ticks; i++) tick(world, rng);
};

const evaluateSingleCellDies = (config, seed) => {
  const rng = mulberry32(seed);
  const world = createWorld(25, 25, config);
  resetWorld(world);
  setCell(world, 12, 12, { type: CellType.PLANT, biomass: 1, energy: 24, gene: 0.5 });

  // 昼夜周期大约 8976 tick，这里覆盖完整一昼夜再加一点余量。
  const horizon = 9800;
  for (let t = 0; t < horizon; t++) {
    tick(world, rng);
    const i = 12 * world.width + 12;
    if (!isAlivePlant(world.front.type, world.front.biomass, i)) return { died: true, deathTick: t + 1 };
  }
  return { died: false, deathTick: horizon };
};

const scoreSingleCellConstraint = (config) => {
  const r = evaluateSingleCellDies(config, 1337);
  if (!r.died) return { score: -120, ...r };
  // 希望在第一夜或第二夜初期死亡（单体难以跨昼夜循环长期存活），但别瞬死。
  const ideal = 7000;
  const dt = r.deathTick;
  const s = 30 - Math.abs(dt - ideal) / 250; // 大概 [-] 到 30
  return { score: clamp(s, -20, 25), ...r };
};

const sampleConfig = (rng) => {
  const diffuseNeighbor = randRange(rng, 0.03, 0.11);
  return {
    diffuseSelf: 1 - diffuseNeighbor,
    diffuseNeighbor,

    baseCost: randRange(rng, 0.0011, 0.0024),
    geneCostFactor: randRange(rng, 0.0038, 0.0064),

    isolationEnergyLoss: randRange(rng, 0.007, 0.016),
    crowdNeighborSoft: randChoice(rng, [4, 5, 6]),
    crowdEnergyLoss: randRange(rng, 0.0012, 0.0048),

    // 其余保持当前默认（但允许外部覆盖）
    timeStep: 0.05,
    sunSpeed: 0.014,
    growthRate: 0.005,
    decayRate: 0.002,
    reproBiomass: 0.92,
    reproEnergy: 14,
    childBiomass: 0.32,
    mutationStep: 0.04,
    reproNeighborCap: 5,
    maxEnergy: 36
  };
};

const main = async () => {
  const args = parseArgs(process.argv);
  const iters = Number(args.iters ?? 80);
  const size = Number(args.size ?? 64);
  const ticks = Number(args.ticks ?? 5200);
  const warmup = Number(args.warmup ?? 600);
  const seeds = Number(args.seeds ?? 3);
  const seed0 = Number(args.seed0 ?? 12345);
  const reportEvery = Number(args.reportEvery ?? 10);

  const searchRng = mulberry32(Number(args.searchSeed ?? 20260223));
  const seedList = Array.from({ length: seeds }, (_, i) => (seed0 + i * 9973) >>> 0);

  let best = null;
  for (let iter = 1; iter <= iters; iter++) {
    const cfg = sampleConfig(searchRng);

    let worldScoreSum = 0;
    let metricsAcc = null;
    for (const s of seedList) {
      const rng = mulberry32(s);
      const world = createWorld(size, size, cfg);
      const seedCount = Math.floor(size * size * 0.12);
      randomSeed(world, seedCount, rng);
      runTicks(world, warmup, rng);
      runTicks(world, ticks, rng);
      const r = scoreWorld(world);
      worldScoreSum += r.score;
      if (!metricsAcc) metricsAcc = { ...r.metrics };
    }
    const worldScore = worldScoreSum / seedList.length;
    const single = scoreSingleCellConstraint(cfg);
    const total = worldScore + single.score;

    if (!best || total > best.total) {
      best = { total, worldScore, single, cfg, sampleMetrics: metricsAcc };
      console.log(
        `[best@${iter}] total=${total.toFixed(2)} world=${worldScore.toFixed(2)} single=${single.score.toFixed(2)} ` +
          `density=${(metricsAcc?.density ?? 0).toFixed(3)} largest=${(metricsAcc?.largestFrac ?? 0).toFixed(3)} ` +
          `holes=${(metricsAcc?.internalEmptyRatio ?? 0).toFixed(3)} smallHoles=${metricsAcc?.smallHoles ?? 0}`
      );
    } else if (reportEvery > 0 && iter % reportEvery === 0) {
      console.log(`[iter ${iter}] bestTotal=${best.total.toFixed(2)}`);
    }
  }

  if (!best) {
    console.log('No result.');
    process.exitCode = 1;
    return;
  }

  console.log('\n=== BEST CONFIG (raw) ===');
  console.log(JSON.stringify(best.cfg, null, 2));
  console.log('\n=== BEST CONFIG (rounded for copy; ~2 sig figs) ===');
  console.log(JSON.stringify(roundConfigForCopy(best.cfg), null, 2));
  console.log('\n=== SCORE BREAKDOWN ===');
  console.log(
    JSON.stringify(
      {
        total: best.total,
        worldScore: best.worldScore,
        singleCell: best.single,
        sampleMetrics: best.sampleMetrics
      },
      null,
      2
    )
  );
};

await main();
