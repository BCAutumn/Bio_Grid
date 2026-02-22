export const DEFAULT_CONFIG = Object.freeze({
  timeStep: 0.05,
  sunSpeed: 0.014,
  diffuseSelf: 0.92,
  diffuseNeighbor: 0.08,
  diffuseGradientThreshold: 1.0,
  diffuseGradientScale: 8.0,
  baseCost: 0.001,
  geneCostFactor: 0.006,
  growthRate: 0.005,
  decayRate: 0.002,
  reproBiomass: 0.60,
  reproEnergy: 10,
  childBiomass: 0.32,
  mutationStep: 0.04,
  isolationEnergyLoss: 0.016,
  isolationZeroNeighborMultiplier: 2,
  isolationGeneBase: 0.4,
  isolationGeneFactor: 1.2,
  crowdNeighborSoft: 4,
  crowdEnergyLoss: 0.0018,
  reproNeighborCap: 4,
  maxEnergy: 40
});

export const mergeConfig = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });
