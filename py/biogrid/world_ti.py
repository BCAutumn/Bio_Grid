"""Taichi(GPU) 常驻世界数据结构（阶段3：性能档）

目标：
- tick/render 使用 ti.ndarray 常驻 GPU/统一内存，避免 Python/NumPy 循环成为瓶颈。
- 保留现有 World(NumPy) 作为“严格对齐档”，用于 JS/Python 对齐测试。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

import numpy as np
import taichi as ti

from .config import Config
from .state import CellType, NeighborCache, MAX_NEIGHBOR_COUNT


@dataclass
class GridTI:
    """单个缓冲区的网格数据（SoA, ti.ndarray 1D）"""

    type: ti.ndarray
    biomass: ti.ndarray
    energy: ti.ndarray
    gene: ti.ndarray
    age: ti.ndarray

    @classmethod
    def create(cls, size: int) -> "GridTI":
        return cls(
            type=ti.ndarray(dtype=ti.u8, shape=(size,)),
            biomass=ti.ndarray(dtype=ti.f32, shape=(size,)),
            energy=ti.ndarray(dtype=ti.f32, shape=(size,)),
            gene=ti.ndarray(dtype=ti.f32, shape=(size,)),
            age=ti.ndarray(dtype=ti.f32, shape=(size,)),
        )


@dataclass
class TerrainTI:
    light: ti.ndarray
    loss: ti.ndarray
    light_min: float = 0.0
    light_max: float = 2.0
    loss_min: float = 1.0
    loss_max: float = 13.0

    @classmethod
    def create(cls, size: int) -> "TerrainTI":
        return cls(
            light=ti.ndarray(dtype=ti.f32, shape=(size,)),
            loss=ti.ndarray(dtype=ti.f32, shape=(size,)),
        )

    def recompute_ranges(self):
        # 仅在编辑地形/初始化时使用（偶发 to_numpy 可接受）
        light = self.light.to_numpy()
        loss = self.loss.to_numpy()
        self.light_min = float(np.min(light)) if light.size else 0.0
        self.light_max = float(np.max(light)) if light.size else 1.0
        self.loss_min = float(np.min(loss)) if loss.size else 0.0
        self.loss_max = float(np.max(loss)) if loss.size else 1.0


@dataclass
class ScratchTI:
    repro_eligible: ti.ndarray
    overflow_out: ti.ndarray
    overflow_in: ti.ndarray
    repro_claim: ti.ndarray  # int32: empty cell -> winning parent id (min), sentinel means none

    @classmethod
    def create(cls, size: int) -> "ScratchTI":
        return cls(
            repro_eligible=ti.ndarray(dtype=ti.u8, shape=(size,)),
            overflow_out=ti.ndarray(dtype=ti.f32, shape=(size,)),
            overflow_in=ti.ndarray(dtype=ti.f32, shape=(size,)),
            repro_claim=ti.ndarray(dtype=ti.i32, shape=(size,)),
        )


@dataclass
class NeighborCacheTI:
    indices: ti.ndarray  # int32, shape=(size * 8,)
    counts: ti.ndarray   # uint8, shape=(size,)

    @classmethod
    def from_numpy_cache(cls, cache: NeighborCache) -> "NeighborCacheTI":
        indices = ti.ndarray(dtype=ti.i32, shape=cache.indices.shape)
        counts = ti.ndarray(dtype=ti.u8, shape=cache.counts.shape)
        indices.from_numpy(cache.indices.astype(np.int32, copy=False))
        counts.from_numpy(cache.counts.astype(np.uint8, copy=False))
        return cls(indices=indices, counts=counts)


class WorldTI:
    """GPU 常驻世界：用于 fast tick + fast 渲染"""

    def __init__(self, width: int, height: int, config: Optional[Config] = None):
        self.width = int(width)
        self.height = int(height)
        self.size = self.width * self.height
        self.config = config or Config()

        # 时间状态（仍用 Python float 维护即可）
        self.time = 0.0
        self.day = 0.0
        self.sunlight = 0.0
        self.tick = 0  # fast tick 计数（用于 hash RNG）

        # 双缓冲
        self.front = GridTI.create(self.size)
        self.back = GridTI.create(self.size)

        # 地形
        self.terrain = TerrainTI.create(self.size)

        # 邻居缓存（一次性上传）
        np_cache = NeighborCache.build(self.width, self.height)
        self.neighbors = NeighborCacheTI.from_numpy_cache(np_cache)

        # scratch
        self.scratch = ScratchTI.create(self.size)

        # flow（先占位，transfer 视图会读取；fast tick 暂不填充）
        self.flow_in = ti.ndarray(dtype=ti.f32, shape=(self.size,))
        self.flow_out = ti.ndarray(dtype=ti.f32, shape=(self.size,))
        self.flow_in.fill(0)
        self.flow_out.fill(0)

        # 统计（viewer 里低频刷新）
        self._stats_total_biomass = ti.field(dtype=ti.f32, shape=())
        self._stats_gene_sum = ti.field(dtype=ti.f32, shape=())
        self._stats_plant_count = ti.field(dtype=ti.i32, shape=())

        # 初始清零
        self.reset()

    def reset(self):
        self.time = 0.0
        self.day = 0.0
        self.sunlight = 0.0
        self.tick = 0
        for g in (self.front, self.back):
            g.type.fill(0)
            g.biomass.fill(0)
            g.energy.fill(0)
            g.gene.fill(0)
            g.age.fill(0)
        self.scratch.repro_eligible.fill(0)
        self.scratch.overflow_out.fill(0)
        self.scratch.overflow_in.fill(0)
        self.scratch.repro_claim.fill(0)
        self.flow_in.fill(0)
        self.flow_out.fill(0)

    def swap_buffers(self):
        self.front, self.back = self.back, self.front

    def set_terrain_linear(self):
        """给 viewer 的默认演示地形：与原 viewer 一致的线性梯度"""
        w = self.width
        h = self.height
        xs = np.tile(np.arange(w, dtype=np.float32), h)
        ys = np.repeat(np.arange(h, dtype=np.float32), w)
        light = 0.5 + (xs / max(1.0, float(w))) * 1.0
        loss = 1.0 + (ys / max(1.0, float(h))) * 5.0
        self.terrain.light.from_numpy(light.astype(np.float32, copy=False))
        self.terrain.loss.from_numpy(loss.astype(np.float32, copy=False))
        self.terrain.recompute_ranges()

    def seed_plants(self, count: int, seed: int = 42):
        """快速播种：在 CPU 构造一次 numpy 缓冲，再整体上传。"""
        rng = np.random.RandomState(seed)
        # 拉回当前 type（只在 reset/seed 时用，不影响 tick 性能）
        t = self.front.type.to_numpy()
        bio = self.front.biomass.to_numpy()
        en = self.front.energy.to_numpy()
        ge = self.front.gene.to_numpy()
        ag = self.front.age.to_numpy()

        placed = 0
        for _ in range(int(count) * 3 + 64):
            if placed >= count:
                break
            x = int(rng.randint(0, self.width))
            y = int(rng.randint(0, self.height))
            i = y * self.width + x
            if t[i] != CellType.EMPTY:
                continue
            t[i] = CellType.PLANT
            bio[i] = 0.5 + rng.random() * 0.5
            en[i] = 20 + rng.random() * 30
            ge[i] = rng.random()
            ag[i] = 0.0
            placed += 1

        # 上传到 front/back
        for g in (self.front, self.back):
            g.type.from_numpy(t.astype(np.uint8, copy=False))
            g.biomass.from_numpy(bio.astype(np.float32, copy=False))
            g.energy.from_numpy(en.astype(np.float32, copy=False))
            g.gene.from_numpy(ge.astype(np.float32, copy=False))
            g.age.from_numpy(ag.astype(np.float32, copy=False))
