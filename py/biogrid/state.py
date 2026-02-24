"""世界状态与数据布局 - 与 JS 侧 world.js/shared.js 对齐"""

import numpy as np
from dataclasses import dataclass, field
from typing import Optional, Tuple
from enum import IntEnum

from .config import Config, DEFAULT_CONFIG


class CellType(IntEnum):
    """细胞类型 - 与 JS CellType 对齐"""
    EMPTY = 0
    PLANT = 1
    HERBIVORE = 2  # 预留
    WALL = 3


# 8邻域偏移（与 JS NEIGHBORS 顺序一致）
NEIGHBORS = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
MAX_NEIGHBOR_COUNT = len(NEIGHBORS)

# RNG 最大开区间值（与 JS RNG_MAX_OPEN 一致）
RNG_MAX_OPEN = 0.9999999999999999


@dataclass
class Grid:
    """单个缓冲区的网格数据（SoA 布局）"""
    type: np.ndarray      # uint8
    biomass: np.ndarray   # float32
    energy: np.ndarray    # float32
    gene: np.ndarray      # float32
    age: np.ndarray       # float32

    @classmethod
    def create(cls, size: int) -> 'Grid':
        return cls(
            type=np.zeros(size, dtype=np.uint8),
            biomass=np.zeros(size, dtype=np.float32),
            energy=np.zeros(size, dtype=np.float32),
            gene=np.zeros(size, dtype=np.float32),
            age=np.zeros(size, dtype=np.float32),
        )

    def copy_from(self, other: 'Grid'):
        """从另一个 Grid 复制数据"""
        np.copyto(self.type, other.type)
        np.copyto(self.biomass, other.biomass)
        np.copyto(self.energy, other.energy)
        np.copyto(self.gene, other.gene)
        np.copyto(self.age, other.age)

    def clear(self):
        """清空所有数据"""
        self.type.fill(0)
        self.biomass.fill(0)
        self.energy.fill(0)
        self.gene.fill(0)
        self.age.fill(0)


@dataclass
class Terrain:
    """地形数据（固定环境层）"""
    light: np.ndarray  # float32, 光照系数
    loss: np.ndarray   # float32, 流失系数
    # 实际范围（用于归一化显示）
    light_min: float = 0.0
    light_max: float = 2.0
    loss_min: float = 1.0
    loss_max: float = 13.0

    @classmethod
    def create(cls, size: int) -> 'Terrain':
        return cls(
            light=np.ones(size, dtype=np.float32),
            loss=np.ones(size, dtype=np.float32),
        )

    def recompute_ranges(self):
        """重新计算实际范围"""
        self.light_min = float(np.min(self.light))
        self.light_max = float(np.max(self.light))
        self.loss_min = float(np.min(self.loss))
        self.loss_max = float(np.max(self.loss))


@dataclass
class NeighborCache:
    """邻居索引缓存（与 JS buildNeighborCache 对齐）"""
    indices: np.ndarray  # int32, shape=(size * MAX_NEIGHBOR_COUNT,)
    counts: np.ndarray   # uint8, shape=(size,)

    @classmethod
    def build(cls, width: int, height: int) -> 'NeighborCache':
        size = width * height
        indices = np.zeros(size * MAX_NEIGHBOR_COUNT, dtype=np.int32)
        counts = np.zeros(size, dtype=np.uint8)

        for y in range(height):
            for x in range(width):
                i = y * width + x
                base = i * MAX_NEIGHBOR_COUNT
                count = 0
                for dx, dy in NEIGHBORS:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        indices[base + count] = ny * width + nx
                        count += 1
                counts[i] = count

        return cls(indices=indices, counts=counts)


@dataclass
class Scratch:
    """临时计算缓冲区"""
    repro_eligible: np.ndarray  # uint8
    overflow_out: np.ndarray    # float32
    overflow_in: np.ndarray     # float32

    @classmethod
    def create(cls, size: int) -> 'Scratch':
        return cls(
            repro_eligible=np.zeros(size, dtype=np.uint8),
            overflow_out=np.zeros(size, dtype=np.float32),
            overflow_in=np.zeros(size, dtype=np.float32),
        )

    def clear(self):
        self.repro_eligible.fill(0)
        self.overflow_out.fill(0)
        self.overflow_in.fill(0)


@dataclass
class Stats:
    """统计数据"""
    tick: int = 0
    total_biomass: float = 0.0
    plant_count: int = 0
    avg_gene: float = 0.0
    normalized_biomass: float = 0.0
    senescent_ratio: float = 0.0


class World:
    """世界状态容器 - 与 JS createWorld 对齐"""

    def __init__(self, width: int = 160, height: int = 160, config: Optional[Config] = None):
        self.width = width
        self.height = height
        self.size = width * height
        self.config = config or Config()

        # 时间状态
        self.time = 0.0
        self.day = 0.0
        self.sunlight = 0.0

        # 双缓冲
        self.front = Grid.create(self.size)
        self.back = Grid.create(self.size)

        # 地形
        self.terrain = Terrain.create(self.size)

        # 邻居缓存
        self.neighbors = NeighborCache.build(width, height)

        # 临时缓冲
        self.scratch = Scratch.create(self.size)

        # 墙体计数
        self.wall_count = 0

        # 统计
        self.stats = Stats()

    def swap_buffers(self):
        """交换前后缓冲"""
        self.front, self.back = self.back, self.front

    def reset(self):
        """重置世界状态"""
        self.front.clear()
        self.back.clear()
        self.time = 0.0
        self.day = 0.0
        self.sunlight = 0.0
        self.wall_count = 0
        self.stats = Stats()

    def to_index(self, x: int, y: int) -> int:
        """坐标转索引"""
        return y * self.width + x

    def from_index(self, i: int) -> Tuple[int, int]:
        """索引转坐标"""
        return i % self.width, i // self.width

    def set_cell(self, x: int, y: int, cell_type: int = None, biomass: float = None,
                 energy: float = None, gene: float = None, age: float = None):
        """设置单个细胞（同时写入前后缓冲）"""
        if not (0 <= x < self.width and 0 <= y < self.height):
            return
        i = self.to_index(x, y)
        self._write_cell(self.front, i, cell_type, biomass, energy, gene, age)
        self._write_cell(self.back, i, cell_type, biomass, energy, gene, age)

    def _write_cell(self, grid: Grid, i: int, cell_type: int = None, biomass: float = None,
                    energy: float = None, gene: float = None, age: float = None):
        """写入单个细胞到指定 Grid"""
        if cell_type is not None:
            prev_type = grid.type[i]
            if prev_type != cell_type:
                if prev_type == CellType.WALL:
                    self.wall_count -= 1
                if cell_type == CellType.WALL:
                    self.wall_count += 1
            grid.type[i] = cell_type
        if biomass is not None:
            grid.biomass[i] = np.clip(biomass, 0.0, 1.0)
        if energy is not None:
            grid.energy[i] = energy
        if gene is not None:
            grid.gene[i] = np.clip(gene, 0.0, 1.0)
        if age is not None:
            grid.age[i] = age

    def export_snapshot(self) -> dict:
        """导出快照（用于对齐测试）"""
        return {
            'width': self.width,
            'height': self.height,
            'time': self.time,
            'day': self.day,
            'sunlight': self.sunlight,
            'wall_count': self.wall_count,
            'config': self.config.to_dict(),
            'front': {
                'type': self.front.type.tolist(),
                'biomass': self.front.biomass.tolist(),
                'energy': self.front.energy.tolist(),
                'gene': self.front.gene.tolist(),
                'age': self.front.age.tolist(),
            },
            'terrain': {
                'light': self.terrain.light.tolist(),
                'loss': self.terrain.loss.tolist(),
            },
            'stats': {
                'tick': self.stats.tick,
                'total_biomass': self.stats.total_biomass,
                'plant_count': self.stats.plant_count,
                'avg_gene': self.stats.avg_gene,
                'normalized_biomass': self.stats.normalized_biomass,
                'senescent_ratio': self.stats.senescent_ratio,
            },
        }

    @classmethod
    def from_snapshot(cls, snapshot: dict) -> 'World':
        """从快照恢复（用于对齐测试）"""
        config = Config.from_dict(snapshot.get('config', {}))
        world = cls(snapshot['width'], snapshot['height'], config)

        world.time = snapshot.get('time', 0.0)
        world.day = snapshot.get('day', 0.0)
        world.sunlight = snapshot.get('sunlight', 0.0)
        world.wall_count = snapshot.get('wall_count', 0)

        front_data = snapshot.get('front', {})
        if front_data:
            world.front.type[:] = np.array(front_data['type'], dtype=np.uint8)
            world.front.biomass[:] = np.array(front_data['biomass'], dtype=np.float32)
            world.front.energy[:] = np.array(front_data['energy'], dtype=np.float32)
            world.front.gene[:] = np.array(front_data['gene'], dtype=np.float32)
            world.front.age[:] = np.array(front_data['age'], dtype=np.float32)
            # 同步到 back
            world.back.copy_from(world.front)

        terrain_data = snapshot.get('terrain', {})
        if terrain_data:
            world.terrain.light[:] = np.array(terrain_data['light'], dtype=np.float32)
            world.terrain.loss[:] = np.array(terrain_data['loss'], dtype=np.float32)
            world.terrain.recompute_ranges()

        stats_data = snapshot.get('stats', {})
        if stats_data:
            world.stats.tick = stats_data.get('tick', 0)
            world.stats.total_biomass = stats_data.get('total_biomass', 0.0)
            world.stats.plant_count = stats_data.get('plant_count', 0)
            world.stats.avg_gene = stats_data.get('avg_gene', 0.0)
            world.stats.normalized_biomass = stats_data.get('normalized_biomass', 0.0)
            world.stats.senescent_ratio = stats_data.get('senescent_ratio', 0.0)

        return world
