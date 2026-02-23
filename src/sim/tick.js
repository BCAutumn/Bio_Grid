import { CellType, MAX_NEIGHBOR_COUNT, RNG_MAX_OPEN } from './shared.js';

const SCRATCH_EMPTY_NEIGHBORS = new Int32Array(8);
const SCRATCH_DIFFUSE_NEIGHBORS = new Int32Array(8);
const SCRATCH_DEFICITS = new Float32Array(8);

export function tick(world, rng = Math.random) {
  const { config, front: a, back: b } = world;
  const terrain = world.terrain;
  const terrainLight = terrain?.light;
  const terrainLoss = terrain?.loss;
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
  const polarDay = !!config.polarDay;
  const rawSunlight = polarDay ? 1 : Math.sin(world.time * config.sunSpeed);
  const sunlight = rawSunlight > 0 ? rawSunlight : 0;
  world.sunlight = sunlight;
  const dayStep = polarDay ? 0 : (config.timeStep * config.sunSpeed) / (Math.PI * 2);
  world.day = (Number.isFinite(world.day) ? world.day : 0) + dayStep;
  const diffuseSelf = config.diffuseSelf;
  const diffuseNeighbor = config.diffuseNeighbor;
  const diffuseGradientThreshold = config.diffuseGradientThreshold ?? 0;
  const diffuseGradientScale = config.diffuseGradientScale ?? 0;
  const norm = diffuseSelf + diffuseNeighbor;
  const keepFrac = norm > 0 ? diffuseSelf / norm : 0;
  const outFrac = norm > 0 ? diffuseNeighbor / norm : 0;
  const osmosisSelf = config.osmosisSelf ?? 1;
  const osmosisNeighbor = config.osmosisNeighbor ?? 0;
  const osmosisGradientThreshold = config.osmosisGradientThreshold ?? 0;
  const osmosisGradientScale = config.osmosisGradientScale ?? 0;
  const osmosisNorm = osmosisSelf + osmosisNeighbor;
  const osmosisOutFrac = osmosisNorm > 0 ? osmosisNeighbor / osmosisNorm : 0;
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
  const rawOverflowShareFrac = (config.overflowShareFrac ?? config.photoShareFrac ?? 0);
  const overflowShareFrac = rawOverflowShareFrac <= 0 ? 0 : rawOverflowShareFrac >= 1 ? 1 : rawOverflowShareFrac;
  const isolationNeighborMin = config.isolationNeighborMin ?? 2;
  const reproEnergyShareFrac = config.reproEnergyShareFrac ?? 0.25;
  const overflowOut = world.scratch.overflowOut;
  const overflowIn = world.scratch.overflowIn;
  const trackFlow = !!config.trackFlow;
  const flowIn = world.flow?.in;
  const flowOut = world.flow?.out;
  const flowVx = world.flow?.vx;
  const flowVy = world.flow?.vy;
  if (trackFlow && flowIn && flowOut && flowVx && flowVy) {
    flowIn.fill(0);
    flowOut.fill(0);
    flowVx.fill(0);
    flowVy.fill(0);
  }

  const aAge = a.age;
  const bAge = b.age;
  // 初始化 write buffer：注意第九章顺序要求“扩散 -> 代谢结算/cap -> 生物量 -> 繁殖 -> 死亡清理”。
  // 这里先把 b 置为 “扩散前的结构镜像”，扩散只写 bEnergy。
  reproEligible.fill(0);
  bType.set(aType);
  bBiomass.set(aBiomass);
  bGene.set(aGene);
  bEnergy.fill(0);
  bAge.set(aAge);

  // --- Phase 1: Diffusion (only living plants participate) ---
  for (let i = 0; i < size; i++) {
    if (hasWalls && aType[i] === wallType) continue;
    // 扩散源必须是“活体植物”（Type=PLANT 且 Biomass>0），与文档定义一致。
    if (aType[i] !== plantType) continue;
    if (aBiomass[i] <= 0) continue;

    const rawSelfE = aEnergy[i];
    if (rawSelfE <= 0) continue;
    const selfE = rawSelfE;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    let deg = 0;
    let neighborESum = 0;
    let neighborFullSum = 0;
    const rawSelfGene = aGene[i];
    const selfGene = rawSelfGene < 0 ? 0 : rawSelfGene > 1 ? 1 : rawSelfGene;
    const selfMaxE = energyMaxBase - selfGene * energyMaxGeneRange;
    const selfFull = selfMaxE > 0 ? selfE / selfMaxE : 0;
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      if (hasWalls && aType[ni] === wallType) continue;
      // 只有“活体植物”邻居才参与能量接收与平均值计算。
      if (aType[ni] !== plantType) continue;
      if (aBiomass[ni] <= 0) continue;
      diffuseNeighbors[deg++] = ni;
      const ne = aEnergy[ni];
      neighborESum += ne > 0 ? ne : 0;
      const rawNg = aGene[ni];
      const ng = rawNg < 0 ? 0 : rawNg > 1 ? 1 : rawNg;
      const nMaxE = energyMaxBase - ng * energyMaxGeneRange;
      const nPosE = ne > 0 ? ne : 0;
      neighborFullSum += nMaxE > 0 ? (nPosE / nMaxE) : 0;
    }
    if (deg > 0) {
      const neighborAvgE = neighborESum / deg;
      const gap = selfE - neighborAvgE;
      let factor = 0;
      if (gap > diffuseGradientThreshold) {
        if (diffuseGradientScale > 0) factor = (gap - diffuseGradientThreshold) / diffuseGradientScale;
        else factor = 1;
        if (factor < 0) factor = 0;
        else if (factor > 1) factor = 1;
      }
      const outPhysical = (selfE * outFrac) * factor;

      // 渗透压项：按“饱腹度”梯度（E/maxE）额外扩散。
      let outOsmosis = 0;
      if (osmosisOutFrac > 0) {
        const neighborAvgFull = neighborFullSum / deg;
        const fullGap = selfFull - neighborAvgFull;
        let of = 0;
        if (fullGap > osmosisGradientThreshold) {
          if (osmosisGradientScale > 0) of = (fullGap - osmosisGradientThreshold) / osmosisGradientScale;
          else of = 1;
          if (of < 0) of = 0;
          else if (of > 1) of = 1;
        }
        outOsmosis = (selfE * osmosisOutFrac) * of;
      }

      let out = outPhysical + outOsmosis;
      if (out > selfE) out = selfE;
      bEnergy[i] += selfE - out;
      // 按能量缺口加权分配：越饿的邻居分得越多（源-汇动力学）
      let totalDeficit = 0;
      for (let k = 0; k < deg; k++) {
        const ni = diffuseNeighbors[k];
        const rawNg = aGene[ni];
        const ng = rawNg < 0 ? 0 : rawNg > 1 ? 1 : rawNg;
        const nMaxE = energyMaxBase - ng * energyMaxGeneRange;
        const ne = aEnergy[ni];
        const nePos = ne > 0 ? ne : 0;
        const def = nMaxE > 0 ? Math.max(0, nMaxE - nePos) : 0;
        SCRATCH_DEFICITS[k] = def;
        totalDeficit += def;
      }
      for (let k = 0; k < deg; k++) {
        const ni = diffuseNeighbors[k];
        const share = totalDeficit > 0 ? out * (SCRATCH_DEFICITS[k] / totalDeficit) : out / deg;
        bEnergy[ni] += share;
        if (trackFlow && flowIn && flowOut && flowVx && flowVy) {
          flowOut[i] += share;
          flowIn[ni] += share;
          const diff = ni - i;
          // neighbor cache 保证 diff 只可能是 8 邻域的合法偏移
          if (diff === 1) flowVx[i] += share;
          else if (diff === -1) flowVx[i] -= share;
          else if (diff === world.width) flowVy[i] += share;
          else if (diff === -world.width) flowVy[i] -= share;
          else if (diff === world.width + 1) { flowVx[i] += share; flowVy[i] += share; }
          else if (diff === world.width - 1) { flowVx[i] -= share; flowVy[i] += share; }
          else if (diff === -world.width + 1) { flowVx[i] += share; flowVy[i] -= share; }
          else if (diff === -world.width - 1) { flowVx[i] -= share; flowVy[i] -= share; }
        }
      }
    } else {
      // 没有活体植物邻居：能量不外流
      bEnergy[i] += selfE;
    }
  }

  // --- Phase 2: Local income/cost -> cap + overflow capture (no biomass yet) ---
  overflowOut.fill(0);
  overflowIn.fill(0);
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
      bEnergy[i] = 0;
      bGene[i] = 0;
      bAge[i] = 0;
      bBiomass[i] = 0;
      overflowOut[i] = 0;
      reproEligible[i] = 0;
      continue;
    }
    const rawGene = aGene[i];
    const gene = rawGene < 0 ? 0 : rawGene > 1 ? 1 : rawGene;
    const age = (aAge[i] || 0) + dayStep;
    const cellMaxAge = ageMaxBase + (1 - gene) * ageMaxGeneRange;
    if (age >= cellMaxAge) {
      bEnergy[i] = 0;
      bBiomass[i] = 0;
      bGene[i] = 0;
      bAge[i] = 0;
      overflowOut[i] = 0;
      reproEligible[i] = 0;
      continue;
    }
    const localSunlight = sunlight * (terrainLight ? terrainLight[i] : 1);
    const income = localSunlight * (photoIncomeBase + gene * photoIncomeGeneFactor);
    const baseCostScaled = baseCost * (terrainLoss ? terrainLoss[i] : 1);
    const cost0 = baseCostScaled + gene * gene * geneCostFactor;
    // 由于 age >= cellMaxAge 会先老死 return，这里的衰老项天然落在 [0, 1) 区间，不需要额外 clamp/min。
    const senescenceDenom = cellMaxAge * (1 - senescenceStartFrac);
    const senescenceT = senescenceDenom > 0 ? Math.max(0, (age - cellMaxAge * senescenceStartFrac) / senescenceDenom) : 0;
    const cost = cost0 + cost0 * senescenceCostExtraMultiplier * senescenceT;
    let energy = bEnergy[i] + income - cost;
    let plantNeighbors = 0;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      const readType = aType[ni];
      if (readType === plantType) plantNeighbors++;
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
    if (energy > cellMaxEnergy) {
      overflowOut[i] = energy - cellMaxEnergy;
      bEnergy[i] = cellMaxEnergy;
    } else {
      overflowOut[i] = 0;
      bEnergy[i] = energy;
    }
  }

  // --- Phase 2.5: Overflow sharing (one-shot, no recursion) ---
  if (overflowShareFrac > 0) {
    for (let i = 0; i < size; i++) {
      if (aType[i] !== plantType) continue;
      if (aBiomass[i] <= 0) continue;
      const ov = overflowOut[i];
      if (ov <= 0) continue;
      const base = i * MAX_NEIGHBOR_COUNT;
      const neighborCount = neighborCounts[i];
      let deg = 0;
      for (let n = 0; n < neighborCount; n++) {
        const ni = neighborIndices[base + n];
        if (hasWalls && aType[ni] === wallType) continue;
        if (aType[ni] !== plantType) continue;
        if (aBiomass[ni] <= 0) continue;
        diffuseNeighbors[deg++] = ni;
      }
      if (deg <= 0) continue;
      const shareTotal = ov * overflowShareFrac;
      if (shareTotal <= 0) continue;
      // 按能量缺口加权分配：越饿的邻居分得越多（源-汇动力学）
      let totalDeficit = 0;
      for (let k = 0; k < deg; k++) {
        const ni = diffuseNeighbors[k];
        const rawNg = bGene[ni];
        const ng = rawNg < 0 ? 0 : rawNg > 1 ? 1 : rawNg;
        const nMaxE = energyMaxBase - ng * energyMaxGeneRange;
        const ne = bEnergy[ni];
        const def = nMaxE > 0 ? Math.max(0, nMaxE - ne) : 0;
        SCRATCH_DEFICITS[k] = def;
        totalDeficit += def;
      }
      for (let k = 0; k < deg; k++) {
        const ni = diffuseNeighbors[k];
        const share = totalDeficit > 0 ? shareTotal * (SCRATCH_DEFICITS[k] / totalDeficit) : shareTotal / deg;
        overflowIn[ni] += share;
        if (trackFlow && flowIn && flowOut && flowVx && flowVy) {
          flowOut[i] += share;
          flowIn[ni] += share;
          const diff = ni - i;
          if (diff === 1) flowVx[i] += share;
          else if (diff === -1) flowVx[i] -= share;
          else if (diff === world.width) flowVy[i] += share;
          else if (diff === -world.width) flowVy[i] -= share;
          else if (diff === world.width + 1) { flowVx[i] += share; flowVy[i] += share; }
          else if (diff === world.width - 1) { flowVx[i] -= share; flowVy[i] += share; }
          else if (diff === -world.width + 1) { flowVx[i] += share; flowVy[i] -= share; }
          else if (diff === -world.width - 1) { flowVx[i] -= share; flowVy[i] -= share; }
        }
      }
    }
  }

  // --- Phase 2.8: Apply overflow -> cap again -> biomass + repro eligibility ---
  for (let i = 0; i < size; i++) {
    if (aType[i] !== plantType) continue;
    if (bBiomass[i] <= 0) {
      reproEligible[i] = 0;
      continue;
    }
    const gene = bGene[i];
    const age = bAge[i] || 0;
    const cellMaxEnergy = energyMaxBase - gene * energyMaxGeneRange;
    const cellMaxBiomass = biomassMaxBase - gene * biomassMaxGeneRange;
    let energy = bEnergy[i] + overflowIn[i];
    if (energy > cellMaxEnergy) energy = cellMaxEnergy;
    bEnergy[i] = energy;

    const biomassDelta = energy > growthEnergyThreshold ? growthRate : (energy <= 0 ? -decayRate : 0);
    const nextBiomassRaw = bBiomass[i] + biomassDelta;
    const nextBiomass = nextBiomassRaw < 0 ? 0 : nextBiomassRaw > cellMaxBiomass ? cellMaxBiomass : nextBiomassRaw;
    bBiomass[i] = nextBiomass;

    const cellMaxAge = ageMaxBase + (1 - gene) * ageMaxGeneRange;
    reproEligible[i] = (nextBiomass > cellMaxBiomass * reproBiomassRatio && energy > cellMaxEnergy * reproEnergyRatio && age <= cellMaxAge * senescenceStartFrac) ? 1 : 0;
  }

  // --- Phase 3: Reproduction (energy transfer after global settle) ---
  for (let i = 0; i < size; i++) {
    if (bType[i] !== plantType) continue;
    if (!reproEligible[i]) continue;
    if (bBiomass[i] <= 0) continue;

    const gene = bGene[i];
    const cellMaxEnergy = energyMaxBase - gene * energyMaxGeneRange;
    const cellMaxBiomass = biomassMaxBase - gene * biomassMaxGeneRange;
    const energyNow = bEnergy[i];
    const biomassNow = bBiomass[i];
    if (!(biomassNow > cellMaxBiomass * reproBiomassRatio && energyNow > cellMaxEnergy * reproEnergyRatio)) continue;

    let plantNeighbors = 0;
    let emptyCount = 0;
    const base = i * MAX_NEIGHBOR_COUNT;
    const neighborCount = neighborCounts[i];
    for (let n = 0; n < neighborCount; n++) {
      const ni = neighborIndices[base + n];
      // “活体植物”判定：Type=PLANT 且 Biomass>0（第九章的定义）。
      if (bType[ni] === plantType && bBiomass[ni] > 0) plantNeighbors++;
      if (bType[ni] === emptyType) emptyNeighbors[emptyCount++] = ni;
    }
    if (emptyCount <= 0) continue;
    if (plantNeighbors < 1 || plantNeighbors > reproNeighborCap) continue;

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
        if (bType[ni] !== plantType) continue;
        if (bBiomass[ni] <= 0) continue;
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

    if (chosenEmpty < 0) continue;

    const parent1Energy = bEnergy[i];
    const parent1Share = parent1Energy * reproEnergyShareFrac;
    const rawParent2Energy = bEnergy[chosenCoParent];
    const parent2Energy = rawParent2Energy > 0 ? rawParent2Energy : 0;
    const parent2Share = parent2Energy * reproEnergyShareFrac;

    bType[chosenEmpty] = plantType;
    bBiomass[chosenEmpty] = childBiomass;
    bEnergy[chosenEmpty] = parent1Share + parent2Share;
    bAge[chosenEmpty] = 0;
    reproEligible[chosenEmpty] = 0;

    const coParentGene = bGene[chosenCoParent];
    const parentPickRoll = rng();
    const parentGene = parentPickRoll < 0.5 ? gene : coParentGene;
    const geneDiff = gene > coParentGene ? gene - coParentGene : coParentGene - gene;
    const actualMutationStep = mutationStep + geneDiff * mutationDistanceFactor;
    const mutationRoll = rng();
    const childGeneRaw = parentGene + (mutationRoll * 2 - 1) * actualMutationStep;
    bGene[chosenEmpty] = childGeneRaw < 0 ? 0 : childGeneRaw > 1 ? 1 : childGeneRaw;

    bEnergy[i] = parent1Energy - parent1Share;
    bEnergy[chosenCoParent] -= parent2Share;
  }

  // --- Phase 4: Death clearing (after reproduction) ---
  for (let i = 0; i < size; i++) {
    if (bType[i] !== plantType) continue;
    if (bBiomass[i] > 0) continue;
    bType[i] = emptyType;
    bEnergy[i] = 0;
    bBiomass[i] = 0;
    bGene[i] = 0;
    bAge[i] = 0;
  }
  world.front = b;
  world.back = a;
  world.stats.tick += 1;
  return world.stats;
}

export function computeStats(world) {
  const { type, biomass, gene } = world.front;
  let totalBiomass = 0;
  let geneSum = 0;
  let plantCount = 0;
  for (let i = 0; i < world.size; i++) if (type[i] === CellType.PLANT) {
    totalBiomass += biomass[i];
    geneSum += gene[i];
    plantCount++;
  }
  world.stats.totalBiomass = totalBiomass;
  world.stats.plantCount = plantCount;
  world.stats.avgGene = plantCount ? geneSum / plantCount : 0;
  return world.stats;
}

