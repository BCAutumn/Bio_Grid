import { CellType, MAX_NEIGHBOR_COUNT, RNG_MAX_OPEN } from './shared.js';

const SCRATCH_EMPTY_NEIGHBORS = new Int32Array(8);
const SCRATCH_DIFFUSE_NEIGHBORS = new Int32Array(8);

export function tick(world, rng = Math.random) {
  const { config, front: a, back: b } = world;
  const size = world.size;
  const neighborIndices = world.neighbors.indices;
  const neighborCounts = world.neighbors.counts;
  const emptyNeighbors = SCRATCH_EMPTY_NEIGHBORS;
  const diffuseNeighbors = SCRATCH_DIFFUSE_NEIGHBORS;
  const reproEligible = world.scratch.reproEligible;
  const typeUpdaters = world.extensions.typeUpdaters;
  const aType = a.type;
  const aBiomass = a.biomass;
  const aEnergy = a.energy;
  const aGene = a.gene;
  const bType = b.type;
  const bBiomass = b.biomass;
  const bEnergy = b.energy;
  const bGene = b.gene;
  const wallType = CellType.WALL;
  const plantType = CellType.PLANT;
  const emptyType = CellType.EMPTY;
  const hasWalls = world.wallCount > 0;
  world.time += config.timeStep;
  const rawSunlight = Math.sin(world.time * config.sunSpeed);
  const sunlight = rawSunlight > 0 ? rawSunlight : 0;
  world.sunlight = sunlight;
  const dayStep = (config.timeStep * config.sunSpeed) / (Math.PI * 2);
  const diffuseSelf = config.diffuseSelf;
  const diffuseNeighbor = config.diffuseNeighbor;
  const diffuseGradientThreshold = config.diffuseGradientThreshold ?? 0;
  const diffuseGradientScale = config.diffuseGradientScale ?? 0;
  const norm = diffuseSelf + diffuseNeighbor;
  const keepFrac = norm > 0 ? diffuseSelf / norm : 0;
  const outFrac = norm > 0 ? diffuseNeighbor / norm : 0;
  const baseCost = config.baseCost;
  const geneCostFactor = config.geneCostFactor;
  const growthEnergyThreshold = config.growthEnergyThreshold ?? 0;
  const growthRate = config.growthRate;
  const decayRate = config.decayRate;
  const isolationEnergyLoss = config.isolationEnergyLoss;
  const isolationZeroNeighborMultiplier = config.isolationZeroNeighborMultiplier ?? 2;
  const isolationGeneBase = config.isolationGeneBase ?? 1;
  const isolationGeneFactor = config.isolationGeneFactor ?? 0;
  const crowdNeighborSoft = config.crowdNeighborSoft;
  const crowdEnergyLoss = config.crowdEnergyLoss;
  const reproNeighborCap = config.reproNeighborCap;
  const reproBiomassRatio = config.reproBiomassRatio ?? 0.5;
  const reproEnergyRatio = config.reproEnergyRatio ?? 0.2;
  const childBiomass = config.childBiomass;
  const mutationStep = config.mutationStep;
  const mutationDistanceFactor = config.mutationDistanceFactor ?? 0.1;
  const energyMaxBase = config.energyMaxBase ?? 72;
  const energyMaxGeneRange = config.energyMaxGeneRange ?? 36;
  const biomassMaxBase = config.biomassMaxBase ?? 1.8;
  const biomassMaxGeneRange = config.biomassMaxGeneRange ?? 0.8;
  const ageMaxBase = config.ageMaxBase ?? 3;
  const ageMaxGeneRange = config.ageMaxGeneRange ?? 1.5;
  const senescenceStartFrac = config.senescenceStartFrac ?? 0.7;
  const senescenceCostExtraMultiplier = config.senescenceCostExtraMultiplier ?? 3;
  const photoIncomeBase = config.photoIncomeBase ?? 0.04;
  const photoIncomeGeneFactor = config.photoIncomeGeneFactor ?? 0.0056;
  const isolationNeighborMin = config.isolationNeighborMin ?? 2;
  const reproEnergyShareFrac = config.reproEnergyShareFrac ?? 0.25;

  const aAge = a.age;
  const bAge = b.age;
  bType.set(aType);
  bBiomass.fill(0);
  bGene.fill(0);
  bEnergy.fill(0);
  bAge.set(aAge);
  for (let i = 0; i < size; i++) {
    if (hasWalls && aType[i] === wallType) {
      continue;
    }
    const rawSelfE = aEnergy[i];
    if (rawSelfE <= 0) continue;
    const selfE = rawSelfE;
    bEnergy[i] += selfE * keepFrac;

    const outMax = selfE * outFrac;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    let deg = 0;
    let neighborESum = 0;
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      if (hasWalls && aType[ni] === wallType) continue;
      // 统一邻居判定：只有“活体植物”才参与能量接收。
      if (aType[ni] !== plantType) continue;
      if (aBiomass[ni] <= 0) continue;
      diffuseNeighbors[deg++] = ni;
      const ne = aEnergy[ni];
      neighborESum += ne > 0 ? ne : 0;
    }
    if (deg > 0) {
      // 梯度驱动扩散：只有当自身能量明显高于邻居平均时才外流。
      const neighborAvgE = neighborESum / deg;
      const gap = selfE - neighborAvgE;
      let factor = 0;
      if (gap > diffuseGradientThreshold) {
        if (diffuseGradientScale > 0) factor = (gap - diffuseGradientThreshold) / diffuseGradientScale;
        else factor = 1;
        if (factor < 0) factor = 0;
        else if (factor > 1) factor = 1;
      }
      const out = outMax * factor;
      // 未外流的部分回流到自身，保证能量守恒且扩散不会“一次性倒空”。
      bEnergy[i] += outMax - out;
      const share = out / deg;
      for (let k = 0; k < deg; k++) bEnergy[diffuseNeighbors[k]] += share;
    } else {
      bEnergy[i] += outMax;
    }
  }
  for (let i = 0; i < size; i++) {
    if (aType[i] !== plantType) {
      reproEligible[i] = 0;
      continue;
    }
    const g = aGene[i];
    const geneVal = g < 0 ? 0 : g > 1 ? 1 : g;
    const cellMaxEnergy = energyMaxBase - geneVal * energyMaxGeneRange;
    const cellMaxBiomass = biomassMaxBase - geneVal * biomassMaxGeneRange;
    
    if (aBiomass[i] <= cellMaxBiomass * reproBiomassRatio || aEnergy[i] <= cellMaxEnergy * reproEnergyRatio) {
      reproEligible[i] = 0;
      continue;
    }

    const maxAge = ageMaxBase + (1 - geneVal) * ageMaxGeneRange;
    const ageNow = aAge[i] || 0;
    reproEligible[i] = ageNow <= maxAge * senescenceStartFrac ? 1 : 0;
  }
  for (let i = 0; i < size; i++) {
    if (aType[i] !== plantType) {
      const nextType = bType[i];
      if (nextType === emptyType || nextType === wallType || nextType === plantType) {
        // empty/wall 维持 0；若是新生植物则保留其已写入数据。
      } else {
        bBiomass[i] = aBiomass[i];
        bGene[i] = aGene[i];
        const updater = typeUpdaters[nextType];
        if (updater) updater({ index: i, world, read: a, write: b, rng });
      }
      continue;
    }
    // 防止出现 type=PLANT 但 biomass<=0 的不一致状态（避免“复活”或参与邻居统计）。
    if (aBiomass[i] <= 0) {
      bType[i] = emptyType;
      bEnergy[i] = 0;
      bGene[i] = 0;
      bAge[i] = 0;
      continue;
    }
    const rawGene = aGene[i];
    const gene = rawGene < 0 ? 0 : rawGene > 1 ? 1 : rawGene;
    const age = (aAge[i] || 0) + dayStep;
    const cellMaxAge = ageMaxBase + (1 - gene) * ageMaxGeneRange;
    if (age >= cellMaxAge) {
      bType[i] = emptyType;
      bEnergy[i] = 0;
      bBiomass[i] = 0;
      bGene[i] = 0;
      bAge[i] = 0;
      continue;
    }
    const income = sunlight * (photoIncomeBase + gene * photoIncomeGeneFactor);
    const cost0 = baseCost + gene * gene * geneCostFactor;
    // 由于 age >= cellMaxAge 会先老死 return，这里的衰老项天然落在 [0, 1) 区间，不需要额外 clamp/min。
    const senescenceDenom = cellMaxAge * (1 - senescenceStartFrac);
    const senescenceT = senescenceDenom > 0 ? Math.max(0, (age - cellMaxAge * senescenceStartFrac) / senescenceDenom) : 0;
    const cost = cost0 + cost0 * senescenceCostExtraMultiplier * senescenceT;
    let energy = bEnergy[i] + income - cost;
    let plantNeighbors = 0;
    let emptyCount = 0;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      const readType = aType[ni];
      if (readType === plantType && aBiomass[ni] > 0) plantNeighbors++;
      if (readType === emptyType && bType[ni] === emptyType) emptyNeighbors[emptyCount++] = ni;
    }
    if (plantNeighbors < isolationNeighborMin) {
      const neighborFactor = plantNeighbors === 0 ? isolationZeroNeighborMultiplier : 1;
      // 更直观的线性形式：低 gene 更耐孤独，高 gene 更吃亏。
      const geneFactor = isolationGeneBase + gene * isolationGeneFactor;
      energy -= isolationEnergyLoss * neighborFactor * geneFactor;
    } else if (plantNeighbors > crowdNeighborSoft) {
      const localCrowd = plantNeighbors - crowdNeighborSoft;
      // 采用非线性拥挤系数（与规则文档示例一致）。
      const crowdFactor = [0, 1, 2, 10, 37][localCrowd] ?? ((2 ** localCrowd) - 1);
      energy -= crowdFactor * crowdEnergyLoss;
    }
    bGene[i] = gene;
    bAge[i] = age;
    const cellMaxEnergy = energyMaxBase - gene * energyMaxGeneRange;
    const cellMaxBiomass = biomassMaxBase - gene * biomassMaxGeneRange;
    const cappedEnergy = energy < cellMaxEnergy ? energy : cellMaxEnergy;
    bEnergy[i] = cappedEnergy;
    const biomassDelta = cappedEnergy > growthEnergyThreshold ? growthRate : (cappedEnergy <= 0 ? -decayRate : 0);
    const nextBiomassRaw = aBiomass[i] + biomassDelta;
    const nextBiomass = nextBiomassRaw < 0 ? 0 : nextBiomassRaw > cellMaxBiomass ? cellMaxBiomass : nextBiomassRaw;
    bBiomass[i] = nextBiomass;
    if (nextBiomass <= 0) {
      bType[i] = emptyType;
      bEnergy[i] = 0;
      bGene[i] = 0;
      bAge[i] = 0;
      continue;
    }
    if (emptyCount > 0 && plantNeighbors >= 1 && plantNeighbors <= reproNeighborCap && nextBiomass > cellMaxBiomass * reproBiomassRatio && cappedEnergy > cellMaxEnergy * reproEnergyRatio) {
      let chosenEmpty = -1;
      let chosenCoParent = -1;
      let validEmptyCount = 0;
      for (let k = 0; k < emptyCount; k++) {
        const empty = emptyNeighbors[k];
        let coParent = -1;
        let coParentCount = 0;
        const emptyBase = empty * MAX_NEIGHBOR_COUNT;
        const emptyNeighborCount = neighborCounts[empty];
        for (let n = 0; n < emptyNeighborCount; n++) {
          const ni = neighborIndices[emptyBase + n];
          if (ni === i) continue;
          if (!reproEligible[ni]) continue;
          coParentCount++;
          const roll = rng();
          const boundedRoll = roll < 1 ? roll : RNG_MAX_OPEN;
          if (((boundedRoll * coParentCount) | 0) === 0) coParent = ni;
        }
        if (coParent < 0) continue;
        validEmptyCount++;
        const roll = rng();
        const boundedRoll = roll < 1 ? roll : RNG_MAX_OPEN;
        if (((boundedRoll * validEmptyCount) | 0) !== 0) continue;
        chosenEmpty = empty;
        chosenCoParent = coParent;
      }

      if (chosenEmpty >= 0) {
        const parent1Share = cappedEnergy * reproEnergyShareFrac;
        const rawParent2Energy = bEnergy[chosenCoParent];
        const parent2Energy = rawParent2Energy > 0 ? rawParent2Energy : 0;
        const parent2Share = parent2Energy * reproEnergyShareFrac;

        bType[chosenEmpty] = plantType;
        bBiomass[chosenEmpty] = childBiomass;
        bEnergy[chosenEmpty] = parent1Share + parent2Share;
        bAge[chosenEmpty] = 0;

        const rawCoParentGene = aGene[chosenCoParent];
        const coParentGene = rawCoParentGene < 0 ? 0 : rawCoParentGene > 1 ? 1 : rawCoParentGene;
        const parentPickRoll = rng();
        const parentGene = parentPickRoll < 0.5 ? gene : coParentGene;
        const geneDiff = gene > coParentGene ? gene - coParentGene : coParentGene - gene;
        const actualMutationStep = mutationStep + geneDiff * mutationDistanceFactor;
        const mutationRoll = rng();
        const childGeneRaw = parentGene + (mutationRoll * 2 - 1) * actualMutationStep;
        bGene[chosenEmpty] = childGeneRaw < 0 ? 0 : childGeneRaw > 1 ? 1 : childGeneRaw;

        bEnergy[i] = cappedEnergy - parent1Share;
        bEnergy[chosenCoParent] -= parent2Share;
      }
    }
  }
  world.front = b;
  world.back = a;
  world.stats.tick += 1;
  world.stats.sunlight = world.sunlight;
  return world.stats;
}

export function computeStats(world) {
  const { type, biomass, gene } = world.front;
  let totalBiomass = 0;
  let geneSum = 0;
  let plantCount = 0;
  for (let i = 0; i < world.size; i++) if (type[i] === CellType.PLANT && biomass[i] > 0) {
    totalBiomass += biomass[i];
    geneSum += gene[i];
    plantCount++;
  }
  world.stats.totalBiomass = totalBiomass;
  world.stats.plantCount = plantCount;
  world.stats.avgGene = plantCount ? geneSum / plantCount : 0;
  world.stats.sunlight = world.sunlight;
  return world.stats;
}


