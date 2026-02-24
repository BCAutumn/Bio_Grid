export const DEFAULT_CONFIG = Object.freeze({
  timeStep: 0.05,
  sunSpeed: 0.014,
  polarDay: false,
  // 调试/可视化：是否追踪每 Tick 的能量传输（用于“能量传输视图”）。默认关闭避免热路径开销。
  trackFlow: false,
  // 能量扩散（物理定律）：默认降低“绝对能量梯度扩散”的外流比例，避免过快全局抹平。
  diffuseSelf: 0.98,
  diffuseNeighbor: 0.02,
  diffuseGradientThreshold: 1.0,
  diffuseGradientScale: 8.0,
  // 渗透压扩散（饱腹度梯度）：额外的“浓度/渗透压”项，驱动 E/maxE 的均衡，从而支持昼夜互哺。
  osmosisSelf: 0.99,
  osmosisNeighbor: 0.01,
  osmosisGradientThreshold: 0.06, // 0.08→0.06，小梯度也能流动，利于源-汇供养
  osmosisGradientScale: 0.32,
  // 溢出分红：当结算后能量超过基因上限（cap）时，溢出部分的一定比例会被分给周围活体植物邻居；
  // 剩余溢出仍会被截断丢弃。该机制不依赖地形/基因显式参数，但会被基因上限与昼夜收入间接影响。
  overflowShareFrac: 0.25,
  // 地形流失只作用于基础代谢基项：Cost0 = base * terrain.loss[i] + gene^2 * factor
  baseCost: 0.0006,
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
  ageMaxGeneRange: 2.5,

  // 衰老：70% 寿命后线性加重，到临近老死时成本增至年轻时 4 倍（额外 +3x）
  senescenceStartFrac: 0.7,
  senescenceCostExtraMultiplier: 3,

  // 光合作用：Income = (Sunlight * terrain.light[i]) * (base + Gene * factor)
  photoIncomeBase: 0.02,
  photoIncomeGeneFactor: 0.03,

  // 孤独判定：邻居活体植物数 < isolationNeighborMin 时触发
  isolationNeighborMin: 2,

  // 繁殖：每个亲本分出能量的 shareFrac 给后代
  reproEnergyShareFrac: 0.25,

  // 用于 UI 显示的能量标尺（默认取保守型上限）；实际每格上限由基因决定
  maxEnergy: 72,

  // --- Terrain (参数集中管理) ---
  // 噪声地形生成：默认保持 loss 约在 1~13 的量级（极端值概率更低，主要靠分布形状控制“尾巴”）。
  terrainNoiseLightMin: 0,
  terrainNoiseLightMax: 2,
  terrainNoiseLossMin: 1,
  terrainNoiseLossMax: 13,
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
  terrainClampLossMin: 1,
  terrainClampLossMax: 25
});

export const mergeConfig = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });
