export const DEFAULT_CONFIG = Object.freeze({
  timeStep: 0.05,
  sunSpeed: 0.014,
  diffuseSelf: 0.92,
  diffuseNeighbor: 0.08,
  diffuseGradientThreshold: 1.0,
  diffuseGradientScale: 8.0,
  // 地形流失只作用于基础代谢基项：Cost0 = base * terrain.loss[i] + gene^2 * factor
  baseCost: 0.0004,
  geneCostFactor: 0.002,
  // 只有当结算后的能量达到该阈值，生物量才会增长（避免“刚天亮能量略正就瞬间回血”）。
  growthEnergyThreshold: 6,
  growthRate: 0.004,
  decayRate: 0.0004,
  reproBiomassRatio: 0.5,
  reproEnergyRatio: 0.2,
  childBiomass: 0.32,
  mutationStep: 0.01,
  mutationDistanceFactor: 0.1,
  isolationEnergyLoss: 0.005,
  isolationZeroNeighborMultiplier: 2,
  isolationGeneBase: 0.4,
  isolationGeneFactor: 1.2,
  crowdNeighborSoft: 4,
  crowdEnergyLoss: 0.0008,
  reproNeighborCap: 4,
  // 体型（能量/生物量上限）与寿命：写进 config 方便对齐 RULES.md 与做参数搜索
  energyMaxBase: 72,
  energyMaxGeneRange: 36,
  biomassMaxBase: 1.8,
  biomassMaxGeneRange: 0.8,
  ageMaxBase: 3,
  ageMaxGeneRange: 1.5,

  // 衰老：70% 寿命后线性加重，到临近老死时成本增至年轻时 4 倍（额外 +3x）
  senescenceStartFrac: 0.7,
  senescenceCostExtraMultiplier: 3,

  // 光合作用：Income = (Sunlight * terrain.light[i]) * (base + Gene * factor)
  photoIncomeBase: 0.04,
  photoIncomeGeneFactor: 0.0056,

  // 孤独判定：邻居活体植物数 < isolationNeighborMin 时触发
  isolationNeighborMin: 2,

  // 繁殖：每个亲本分出能量的 shareFrac 给后代
  reproEnergyShareFrac: 0.25,

  // 用于 UI 显示的能量标尺（默认取保守型上限）；实际每格上限由基因决定
  maxEnergy: 72,

  // --- Terrain (参数集中管理) ---
  // 噪声地形生成：默认保持 loss 约在 0~12 的量级（极端值概率更低，主要靠分布形状控制“尾巴”）。
  terrainNoiseLightMin: 0,
  terrainNoiseLightMax: 2,
  terrainNoiseLossMin: 0,
  terrainNoiseLossMax: 12,
  terrainBaseFreq: 4.8,
  terrainOctaves: 4,
  terrainSeedLight: 11.37,
  terrainSeedLoss: 73.91,
  terrainOffsetX: 19.3,
  terrainOffsetY: -7.1,
  // 噪声分布形状：用多次独立 FBM 取平均，整体更接近“正态/钟形”（极端值概率更低）。
  // - 'flat': 单次 FBM（更接近均匀）
  // - 'normal': 多次独立 FBM 平均（推荐）
  terrainNoiseDistribution: 'normal',
  terrainNoiseNormalSamples: 3,

  // 地形编辑/归一化的允许范围（UI 视图和笔刷使用；实际显示范围会根据当前地形值自动扫描）。
  terrainClampLightMin: 0,
  terrainClampLightMax: 2,
  terrainClampLossMin: 0,
  terrainClampLossMax: 24
});

export const mergeConfig = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });
