"""配置参数映射 - 与 src/config.js DEFAULT_CONFIG 完全对齐"""

from dataclasses import dataclass, field
from typing import Optional

# 默认配置（与 JS 侧 DEFAULT_CONFIG 一一对应）
DEFAULT_CONFIG = {
    # 时间与昼夜
    'timeStep': 0.05,
    'sunSpeed': 0.014,
    'polarDay': False,
    'trackFlow': False,

    # 能量扩散（物理梯度）
    'diffuseSelf': 0.98,
    'diffuseNeighbor': 0.02,
    'diffuseGradientThreshold': 1.0,
    'diffuseGradientScale': 8.0,

    # 渗透压扩散（饱腹度梯度）
    'osmosisSelf': 0.99,
    'osmosisNeighbor': 0.01,
    'osmosisGradientThreshold': 0.06,
    'osmosisGradientScale': 0.32,

    # 溢出分红
    'overflowShareFrac': 0.25,

    # 代谢
    'baseCost': 0.0004,
    'geneCostFactor': 0.002,

    # 生长/凋亡
    'growthEnergyThreshold': 6.0,
    'growthRate': 0.004,
    'decayRate': 0.0004,

    # 繁殖
    'reproBiomassRatio': 0.5,
    'reproEnergyRatio': 0.2,
    'childBiomass': 0.32,
    'mutationStep': 0.01,
    'mutationDistanceFactor': 0.1,
    'reproNeighborCap': 4,
    'reproEnergyShareFrac': 0.25,

    # 孤独惩罚
    'isolationEnergyLoss': 0.005,
    'isolationZeroNeighborMultiplier': 2.0,
    'isolationGeneBase': 0.4,
    'isolationGeneFactor': 1.2,
    'isolationNeighborMin': 2,

    # 拥挤惩罚
    'crowdNeighborSoft': 4,
    'crowdEnergyLoss': 0.0008,

    # 体型（能量/生物量上限）
    'energyMaxBase': 72.0,
    'energyMaxGeneRange': 36.0,
    'biomassMaxBase': 1.8,
    'biomassMaxGeneRange': 0.8,

    # 寿命与衰老
    'ageMaxBase': 3.0,
    'ageMaxGeneRange': 1.5,
    'senescenceStartFrac': 0.7,
    'senescenceCostExtraMultiplier': 3.0,

    # 光合作用
    'photoIncomeBase': 0.04,
    'photoIncomeGeneFactor': 0.0084,

    # UI 显示用
    'maxEnergy': 72.0,

    # 地形生成参数（用于从头创建世界时）
    'terrainNoiseLightMin': 0.0,
    'terrainNoiseLightMax': 2.0,
    'terrainNoiseLossMin': 0.0,
    'terrainNoiseLossMax': 12.0,
    'terrainBaseFreq': 4.8,
    'terrainOctaves': 4,
    'terrainSeedLight': 11.37,
    'terrainSeedLoss': 73.91,
    'terrainOffsetX': 19.3,
    'terrainOffsetY': -7.1,
    'terrainNoiseDistribution': 'normal',
    'terrainNoiseNormalSamples': 3,
    'terrainClampLightMin': 0.0,
    'terrainClampLightMax': 2.0,
    'terrainClampLossMin': 0.0,
    'terrainClampLossMax': 24.0,
}


@dataclass
class Config:
    """配置类 - 提供类型安全的配置访问"""
    # 时间与昼夜
    timeStep: float = 0.05
    sunSpeed: float = 0.014
    polarDay: bool = False
    trackFlow: bool = False

    # 能量扩散（物理梯度）
    diffuseSelf: float = 0.98
    diffuseNeighbor: float = 0.02
    diffuseGradientThreshold: float = 1.0
    diffuseGradientScale: float = 8.0

    # 渗透压扩散（饱腹度梯度）
    osmosisSelf: float = 0.99
    osmosisNeighbor: float = 0.01
    osmosisGradientThreshold: float = 0.06
    osmosisGradientScale: float = 0.32

    # 溢出分红
    overflowShareFrac: float = 0.25

    # 代谢
    baseCost: float = 0.0004
    geneCostFactor: float = 0.002

    # 生长/凋亡
    growthEnergyThreshold: float = 6.0
    growthRate: float = 0.004
    decayRate: float = 0.0004

    # 繁殖
    reproBiomassRatio: float = 0.5
    reproEnergyRatio: float = 0.2
    childBiomass: float = 0.32
    mutationStep: float = 0.01
    mutationDistanceFactor: float = 0.1
    reproNeighborCap: int = 4
    reproEnergyShareFrac: float = 0.25

    # 孤独惩罚
    isolationEnergyLoss: float = 0.005
    isolationZeroNeighborMultiplier: float = 2.0
    isolationGeneBase: float = 0.4
    isolationGeneFactor: float = 1.2
    isolationNeighborMin: int = 2

    # 拥挤惩罚
    crowdNeighborSoft: int = 4
    crowdEnergyLoss: float = 0.0008

    # 体型（能量/生物量上限）
    energyMaxBase: float = 72.0
    energyMaxGeneRange: float = 36.0
    biomassMaxBase: float = 1.8
    biomassMaxGeneRange: float = 0.8

    # 寿命与衰老
    ageMaxBase: float = 3.0
    ageMaxGeneRange: float = 1.5
    senescenceStartFrac: float = 0.7
    senescenceCostExtraMultiplier: float = 3.0

    # 光合作用
    photoIncomeBase: float = 0.04
    photoIncomeGeneFactor: float = 0.0084

    # UI 显示用
    maxEnergy: float = 72.0

    @classmethod
    def from_dict(cls, d: dict) -> 'Config':
        """从字典创建配置（忽略未知键）"""
        valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in d.items() if k in valid_keys}
        return cls(**filtered)

    def to_dict(self) -> dict:
        """导出为字典"""
        from dataclasses import asdict
        return asdict(self)

    # 派生属性（便于计算）
    @property
    def diffuse_out_frac(self) -> float:
        norm = self.diffuseSelf + self.diffuseNeighbor
        return self.diffuseNeighbor / norm if norm > 0 else 0.0

    @property
    def osmosis_out_frac(self) -> float:
        norm = self.osmosisSelf + self.osmosisNeighbor
        return self.osmosisNeighbor / norm if norm > 0 else 0.0

    def max_energy(self, gene: float) -> float:
        """根据基因计算能量上限"""
        return self.energyMaxBase - gene * self.energyMaxGeneRange

    def max_biomass(self, gene: float) -> float:
        """根据基因计算生物量上限"""
        return self.biomassMaxBase - gene * self.biomassMaxGeneRange

    def max_age(self, gene: float) -> float:
        """根据基因计算最大寿命"""
        return self.ageMaxBase + (1.0 - gene) * self.ageMaxGeneRange
