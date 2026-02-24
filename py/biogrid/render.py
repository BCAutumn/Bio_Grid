"""Taichi 渲染模块 - 与 src/render.js paintWorldToPixels 对齐

支持的视图模式:
- eco: 生态视图（默认）
- terrainLight: 地形光照视图
- terrainLoss: 地形流失视图
- terrainMix: 复合地形视图
- transfer: 能量传输视图

另外提供 `TaichiViewRenderer`：以“视野窗口 + 输出分辨率”渲染，
对齐 `src/render.js` 的 `paintWorldToPixelsView`（用于后端渲染给前端）。
"""

import taichi as ti
import numpy as np
from typing import Optional
import math

from .state import World, CellType

# 常量
GENE_LUT_SIZE = 256
SAT_LUT_SIZE = 64
SAT_E_MAX = 40.0
PHASE_TAU = math.pi * 2


def _clamp(v: float, min_v: float, max_v: float) -> float:
    return min(max_v, max(min_v, v))


def _hsv_to_rgb(h: float, s: float, v: float):
    """HSV 转 RGB（与 JS hsvToRgb 对齐）"""
    sat = _clamp(s, 0, 1)
    val = _clamp(v, 0, 1)
    c = val * sat
    hp = (h % 360) / 60
    x = c * (1 - abs((hp % 2) - 1))
    r, g, b = 0.0, 0.0, 0.0
    if 0 <= hp < 1:
        r, g, b = c, x, 0
    elif hp < 2:
        r, g, b = x, c, 0
    elif hp < 3:
        r, g, b = 0, c, x
    elif hp < 4:
        r, g, b = 0, x, c
    elif hp < 5:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    m = val - c
    return (r + m) * 255, (g + m) * 255, (b + m) * 255


def _build_hsv_lut() -> np.ndarray:
    """构建 HSV 系数 LUT（与 JS 对齐）"""
    lut = np.zeros((GENE_LUT_SIZE, SAT_LUT_SIZE, 3), dtype=np.float32)
    for gi in range(GENE_LUT_SIZE):
        g = gi / (GENE_LUT_SIZE - 1)
        # gene=0 -> 220deg（中等偏深蓝），比旧版更蓝但不过深
        hue = 220 - g * 200
        for si in range(SAT_LUT_SIZE):
            e = (si / (SAT_LUT_SIZE - 1)) * SAT_E_MAX
            sat = _clamp((20 + math.log1p(e) * 18) / 100, 0.08, 1)
            r, gg, b = _hsv_to_rgb(hue, sat, 1)
            lut[gi, si, 0] = r / 255
            lut[gi, si, 1] = gg / 255
            lut[gi, si, 2] = b / 255
    return lut


def _phase_from_index(i: int) -> float:
    """从索引生成稳定相位（与 JS phaseFromIndex 对齐）"""
    h = (i & 0xFFFFFFFF) ^ 0x9e3779b9
    h ^= (h >> 16) & 0xFFFFFFFF
    h = (h * 0x85ebca6b) & 0xFFFFFFFF
    h ^= (h >> 13) & 0xFFFFFFFF
    h = (h * 0xc2b2ae35) & 0xFFFFFFFF
    h ^= (h >> 16) & 0xFFFFFFFF
    return (h / 4294967296) * PHASE_TAU


# 预构建 LUT
HSV_COEFF_LUT = _build_hsv_lut()


@ti.data_oriented
class TaichiRenderer:
    """Taichi GPU 渲染器"""

    def __init__(self, width: int, height: int):
        self.width = width
        self.height = height

        # 输出图像 (RGB, float32)
        self.img = ti.Vector.field(3, dtype=ti.f32, shape=(width, height))

        # HSV LUT (上传到 Taichi)
        self.hsv_lut = ti.Vector.field(3, dtype=ti.f32, shape=(GENE_LUT_SIZE, SAT_LUT_SIZE))
        self._upload_lut()

        # 相位 LUT (预计算)
        self.phase_lut = ti.field(dtype=ti.f32, shape=(width * height,))
        self._compute_phase_lut()

    def _upload_lut(self):
        """上传 HSV LUT 到 Taichi"""
        for gi in range(GENE_LUT_SIZE):
            for si in range(SAT_LUT_SIZE):
                self.hsv_lut[gi, si] = ti.Vector([
                    HSV_COEFF_LUT[gi, si, 0],
                    HSV_COEFF_LUT[gi, si, 1],
                    HSV_COEFF_LUT[gi, si, 2]
                ])

    def _compute_phase_lut(self):
        """预计算相位 LUT"""
        phases = np.array([_phase_from_index(i) for i in range(self.width * self.height)], dtype=np.float32)
        self.phase_lut.from_numpy(phases)

    @ti.kernel
    def _render_eco(self,
                    cell_type: ti.types.ndarray(dtype=ti.u8),
                    biomass: ti.types.ndarray(dtype=ti.f32),
                    energy: ti.types.ndarray(dtype=ti.f32),
                    gene: ti.types.ndarray(dtype=ti.f32),
                    age: ti.types.ndarray(dtype=ti.f32),
                    terrain_light: ti.types.ndarray(dtype=ti.f32),
                    terrain_loss: ti.types.ndarray(dtype=ti.f32),
                    light_min: ti.f32, light_max: ti.f32,
                    loss_min: ti.f32, loss_max: ti.f32,
                    show_aging_glow: ti.i32):
        """渲染 eco 视图"""
        for i in range(self.width * self.height):
            x = i % self.width
            y = i // self.width
            t = cell_type[i]

            light_factor = terrain_light[i]
            loss_factor = terrain_loss[i]
            light_span = light_max - light_min
            loss_span = loss_max - loss_min
            light_norm = ti.max(0.0, ti.min(1.0, (light_factor - light_min) / light_span)) if light_span > 0 else 0.0
            loss_norm = ti.max(0.0, ti.min(1.0, (loss_factor - loss_min) / loss_span)) if loss_span > 0 else 0.0

            r, g, b = 0.0, 0.0, 0.0

            if t == 3:  # WALL
                r, g, b = 210.0 / 255, 215.0 / 255, 220.0 / 255
            elif t == 0:  # EMPTY
                r = (5 + light_norm * 14 + loss_norm * 14) / 255
                g = (8 + light_norm * 21 - loss_norm * 5) / 255
                b = (12 + light_norm * 28 - loss_norm * 10) / 255
            else:  # PLANT
                e_raw = energy[i]
                e = ti.max(0.0, e_raw)
                gv = gene[i]
                g_idx = ti.cast(gv * 255, ti.i32)
                g_idx = ti.max(0, ti.min(255, g_idx))
                e_idx = ti.cast((e / 40.0) * 63, ti.i32) if e < 40 else 63
                e_idx = ti.max(0, ti.min(63, e_idx))

                lut_val = self.hsv_lut[g_idx, e_idx]
                bio = biomass[i]
                value = ti.min(1.0, bio * 0.9 + ti.min(0.12, e * 0.0025))

                r = lut_val[0] * value
                g = lut_val[1] * value
                b = lut_val[2] * value

                # 衰老发光
                if show_aging_glow == 1 and bio > 0 and age[i] > 0:
                    cell_max_age = 3.0 + (1.0 - gv) * 1.5
                    senescence_factor = (age[i] - cell_max_age * 0.7) / (cell_max_age * 0.3)
                    if senescence_factor > 0:
                        glow = ti.min(1.0, senescence_factor) * 0.85
                        r = ti.min(1.0, r + (1.0 - r) * glow)
                        g *= (1.0 - glow)
                        b *= (1.0 - glow)

            # 注意：Taichi GUI 的 y 轴是从下往上，需要翻转
            self.img[x, self.height - 1 - y] = ti.Vector([r, g, b])

    @ti.kernel
    def _render_terrain_light(self,
                              cell_type: ti.types.ndarray(dtype=ti.u8),
                              terrain_light: ti.types.ndarray(dtype=ti.f32),
                              light_min: ti.f32, light_max: ti.f32):
        """渲染地形光照视图"""
        for i in range(self.width * self.height):
            x = i % self.width
            y = i // self.width
            t = cell_type[i]

            if t == 3:  # WALL
                self.img[x, self.height - 1 - y] = ti.Vector([210.0 / 255, 215.0 / 255, 220.0 / 255])
            else:
                light_factor = terrain_light[i]
                light_span = light_max - light_min
                light_norm = ti.max(0.0, ti.min(1.0, (light_factor - light_min) / light_span)) if light_span > 0 else 0.0
                v = 28 + light_norm * 210
                r = (28 + v * 1.05) / 255
                g = (20 + v * 0.78) / 255
                b = (6 + v * 0.18) / 255
                self.img[x, self.height - 1 - y] = ti.Vector([r, g, b])

    @ti.kernel
    def _render_terrain_loss(self,
                             cell_type: ti.types.ndarray(dtype=ti.u8),
                             terrain_loss: ti.types.ndarray(dtype=ti.f32),
                             loss_min: ti.f32, loss_max: ti.f32):
        """渲染地形流失视图"""
        for i in range(self.width * self.height):
            x = i % self.width
            y = i // self.width
            t = cell_type[i]

            if t == 3:  # WALL
                self.img[x, self.height - 1 - y] = ti.Vector([210.0 / 255, 215.0 / 255, 220.0 / 255])
            else:
                loss_factor = terrain_loss[i]
                loss_span = loss_max - loss_min
                loss_norm = ti.max(0.0, ti.min(1.0, (loss_factor - loss_min) / loss_span)) if loss_span > 0 else 0.0
                r = (35 + loss_norm * 210) / 255
                g = (145 - loss_norm * 90) / 255
                b = (215 - loss_norm * 185) / 255
                self.img[x, self.height - 1 - y] = ti.Vector([r, g, b])

    @ti.kernel
    def _render_terrain_mix(self,
                            cell_type: ti.types.ndarray(dtype=ti.u8),
                            terrain_light: ti.types.ndarray(dtype=ti.f32),
                            terrain_loss: ti.types.ndarray(dtype=ti.f32),
                            light_min: ti.f32, light_max: ti.f32,
                            loss_min: ti.f32, loss_max: ti.f32):
        """渲染复合地形视图"""
        for i in range(self.width * self.height):
            x = i % self.width
            y = i // self.width
            t = cell_type[i]

            if t == 3:  # WALL
                self.img[x, self.height - 1 - y] = ti.Vector([210.0 / 255, 215.0 / 255, 220.0 / 255])
            else:
                light_factor = terrain_light[i]
                loss_factor = terrain_loss[i]
                light_span = light_max - light_min
                loss_span = loss_max - loss_min
                light_norm = ti.max(0.0, ti.min(1.0, (light_factor - light_min) / light_span)) if light_span > 0 else 0.0
                loss_norm = ti.max(0.0, ti.min(1.0, (loss_factor - loss_min) / loss_span)) if loss_span > 0 else 0.0
                r = (40 + loss_norm * 210) / 255
                g = (30 + light_norm * 210) / 255
                b = (30 + (1 - loss_norm) * 60 + light_norm * 150) / 255
                self.img[x, self.height - 1 - y] = ti.Vector([r, g, b])

    @ti.kernel
    def _render_transfer(self,
                         cell_type: ti.types.ndarray(dtype=ti.u8),
                         biomass: ti.types.ndarray(dtype=ti.f32),
                         energy: ti.types.ndarray(dtype=ti.f32),
                         gene: ti.types.ndarray(dtype=ti.f32),
                         terrain_light: ti.types.ndarray(dtype=ti.f32),
                         terrain_loss: ti.types.ndarray(dtype=ti.f32),
                         flow_in: ti.types.ndarray(dtype=ti.f32),
                         flow_out: ti.types.ndarray(dtype=ti.f32),
                         light_min: ti.f32, light_max: ti.f32,
                         loss_min: ti.f32, loss_max: ti.f32,
                         now_ms: ti.f32):
        """渲染能量传输视图"""
        FLOW_MIN = 0.0045
        FLOW_SCALE = 60.0

        for i in range(self.width * self.height):
            x = i % self.width
            y = i // self.width
            t = cell_type[i]

            light_factor = terrain_light[i]
            loss_factor = terrain_loss[i]
            light_span = light_max - light_min
            loss_span = loss_max - loss_min
            light_norm = ti.max(0.0, ti.min(1.0, (light_factor - light_min) / light_span)) if light_span > 0 else 0.0
            loss_norm = ti.max(0.0, ti.min(1.0, (loss_factor - loss_min) / loss_span)) if loss_span > 0 else 0.0

            r, g, b = 0.0, 0.0, 0.0

            if t == 3:  # WALL
                r, g, b = 210.0 / 255, 215.0 / 255, 220.0 / 255
            elif t == 0:  # EMPTY
                base = 10 + light_norm * 10 + (1 - loss_norm) * 6
                r = base / 255
                g = base / 255
                b = (base + 4) / 255
            else:  # PLANT
                fin = flow_in[i]
                fout = flow_out[i]
                mag = fin + fout
                net = fin - fout

                phase = self.phase_lut[i]
                pulse = 0.88 + 0.12 * ti.sin(now_ms * 0.0028 + phase)

                mag_norm = ti.max(0.0, ti.min(1.0, (mag - FLOW_MIN) * FLOW_SCALE)) if mag > FLOW_MIN else 0.0
                intensity = (mag_norm ** 1.9) * ti.max(0.0, ti.min(1.0, pulse))

                # 源（净流出）偏冷色，汇（净流入）偏暖色
                src = 1 if net < 0 else 0
                hr = 50.0 if src else 255.0
                hg = 210.0 if src else 190.0
                hb = 255.0 if src else 70.0

                # 底色
                e_raw = energy[i]
                e = ti.max(0.0, e_raw)
                gv = gene[i]
                g_idx = ti.cast(gv * 255, ti.i32)
                g_idx = ti.max(0, ti.min(255, g_idx))
                e_idx = ti.cast((e / 40.0) * 63, ti.i32) if e < 40 else 63
                e_idx = ti.max(0, ti.min(63, e_idx))

                lut_val = self.hsv_lut[g_idx, e_idx]
                bio = biomass[i]
                value = ti.min(0.35, bio * 0.35 + ti.min(0.08, e * 0.0018))
                scale = value * 0.65

                r = lut_val[0] * scale
                g = lut_val[1] * scale
                b = lut_val[2] * scale

                r = r + (hr / 255 - r) * intensity
                g = g + (hg / 255 - g) * intensity
                b = b + (hb / 255 - b) * intensity

            self.img[x, self.height - 1 - y] = ti.Vector([
                ti.max(0.0, ti.min(1.0, r)),
                ti.max(0.0, ti.min(1.0, g)),
                ti.max(0.0, ti.min(1.0, b))
            ])

    def render(self, world: World, view_mode: str = 'eco',
               show_aging_glow: bool = False, now_ms: float = 0.0):
        """渲染世界到图像缓冲区

        Args:
            world: 世界状态
            view_mode: 视图模式 ('eco', 'terrainLight', 'terrainLoss', 'terrainMix', 'transfer')
            show_aging_glow: 是否显示衰老发光
            now_ms: 当前时间（毫秒，用于 transfer 视图闪烁）
        """
        front = world.front
        terrain = world.terrain

        light_min = terrain.light_min
        light_max = terrain.light_max
        loss_min = terrain.loss_min
        loss_max = terrain.loss_max

        if view_mode == 'terrainLight':
            self._render_terrain_light(
                front.type, terrain.light,
                light_min, light_max
            )
        elif view_mode == 'terrainLoss':
            self._render_terrain_loss(
                front.type, terrain.loss,
                loss_min, loss_max
            )
        elif view_mode == 'terrainMix':
            self._render_terrain_mix(
                front.type, terrain.light, terrain.loss,
                light_min, light_max, loss_min, loss_max
            )
        elif view_mode == 'transfer':
            # 确保 flow 数据存在
            flow_in = getattr(world, 'flow_in', None)
            flow_out = getattr(world, 'flow_out', None)
            if flow_in is None:
                flow_in = np.zeros(world.size, dtype=np.float32)
            if flow_out is None:
                flow_out = np.zeros(world.size, dtype=np.float32)
            self._render_transfer(
                front.type, front.biomass, front.energy, front.gene,
                terrain.light, terrain.loss,
                flow_in, flow_out,
                light_min, light_max, loss_min, loss_max,
                now_ms
            )
        else:  # eco
            self._render_eco(
                front.type, front.biomass, front.energy, front.gene, front.age,
                terrain.light, terrain.loss,
                light_min, light_max, loss_min, loss_max,
                1 if show_aging_glow else 0
            )

    def get_image(self) -> np.ndarray:
        """获取渲染结果（numpy 数组）"""
        return self.img.to_numpy()


def create_renderer(width: int, height: int) -> TaichiRenderer:
    """创建渲染器（需要先初始化 Taichi）"""
    return TaichiRenderer(width, height)


@ti.data_oriented
class TaichiViewRenderer:
    """按视野渲染到指定输出分辨率（RGBA u8）。

    设计目标：
    - 输出尺寸固定为 out_w/out_h（通常等于前端 canvas 像素尺寸）
    - 通过 (sx, sy, sw, sh) 把输出像素映射到 world 网格坐标采样
    """

    def __init__(self, out_w: int, out_h: int):
        self.out_w = int(max(1, out_w))
        self.out_h = int(max(1, out_h))
        # shape=(H,W) 更贴近 numpy [y,x] 的布局
        self.rgba = ti.Vector.field(4, dtype=ti.u8, shape=(self.out_h, self.out_w))
        # HSV LUT（一次性上传，用于 eco/transfer 底色计算）
        self.hsv_lut = ti.Vector.field(3, dtype=ti.f32, shape=(GENE_LUT_SIZE, SAT_LUT_SIZE))
        for gi in range(GENE_LUT_SIZE):
            for si in range(SAT_LUT_SIZE):
                self.hsv_lut[gi, si] = ti.Vector([
                    HSV_COEFF_LUT[gi, si, 0],
                    HSV_COEFF_LUT[gi, si, 1],
                    HSV_COEFF_LUT[gi, si, 2],
                ])
        self._zero_flow = None
        self._zero_flow_size = 0

    @staticmethod
    @ti.func
    def _clampi(v: ti.i32, lo: ti.i32, hi: ti.i32) -> ti.i32:
        return ti.min(hi, ti.max(lo, v))

    @ti.kernel
    def _render_view(self,
                     world_w: ti.i32, world_h: ti.i32,
                     sx: ti.f32, sy: ti.f32, sw: ti.f32, sh: ti.f32,
                     cell_type: ti.types.ndarray(dtype=ti.u8),
                     biomass: ti.types.ndarray(dtype=ti.f32),
                     energy: ti.types.ndarray(dtype=ti.f32),
                     gene: ti.types.ndarray(dtype=ti.f32),
                     age: ti.types.ndarray(dtype=ti.f32),
                     terrain_light: ti.types.ndarray(dtype=ti.f32),
                     terrain_loss: ti.types.ndarray(dtype=ti.f32),
                     light_min: ti.f32, light_max: ti.f32,
                     loss_min: ti.f32, loss_max: ti.f32,
                     flow_in: ti.types.ndarray(dtype=ti.f32),
                     flow_out: ti.types.ndarray(dtype=ti.f32),
                     view_mode: ti.i32,
                     show_aging_glow: ti.i32,
                     now_ms: ti.f32):
        # view_mode: 0 eco, 1 terrainLight, 2 terrainLoss, 3 terrainMix, 4 transfer
        SAT_E_MAX = 40.0
        FLOW_MIN = 0.0045
        FLOW_SCALE = 60.0

        light_span = light_max - light_min
        loss_span = loss_max - loss_min

        for py, px in self.rgba:
            # 采样 world 坐标（对齐 JS paintWorldToPixelsView：用像素中心 (p+0.5)）
            wx = ti.floor(sx + (ti.cast(px, ti.f32) + 0.5) * sw / ti.cast(self.out_w, ti.f32))
            wy = ti.floor(sy + (ti.cast(py, ti.f32) + 0.5) * sh / ti.cast(self.out_h, ti.f32))
            x = self._clampi(ti.cast(wx, ti.i32), 0, world_w - 1)
            y = self._clampi(ti.cast(wy, ti.i32), 0, world_h - 1)
            i = y * world_w + x

            t = cell_type[i]
            # 归一化地形
            lf = terrain_light[i]
            losf = terrain_loss[i]
            light_norm = ti.max(0.0, ti.min(1.0, (lf - light_min) / light_span)) if light_span > 0 else 0.0
            loss_norm = ti.max(0.0, ti.min(1.0, (losf - loss_min) / loss_span)) if loss_span > 0 else 0.0

            r = 0.0
            g = 0.0
            b = 0.0

            if t == ti.u8(CellType.WALL):
                r, g, b = 210.0, 215.0, 220.0
            else:
                if view_mode == 1:  # terrainLight
                    v = 28.0 + light_norm * 210.0
                    r = 28.0 + v * 1.05
                    g = 20.0 + v * 0.78
                    b = 6.0 + v * 0.18
                elif view_mode == 2:  # terrainLoss
                    r = 35.0 + loss_norm * 210.0
                    g = 145.0 - loss_norm * 90.0
                    b = 215.0 - loss_norm * 185.0
                elif view_mode == 3:  # terrainMix
                    r = 40.0 + loss_norm * 210.0
                    g = 30.0 + light_norm * 210.0
                    b = 30.0 + (1.0 - loss_norm) * 60.0 + light_norm * 150.0
                elif view_mode == 4:  # transfer
                    if t == ti.u8(CellType.EMPTY):
                        base = 10.0 + light_norm * 10.0 + (1.0 - loss_norm) * 6.0
                        r = base
                        g = base
                        b = base + 4.0
                    elif t != ti.u8(CellType.PLANT):
                        r, g, b = 14.0, 14.0, 18.0
                    else:
                        fin = flow_in[i]
                        fout = flow_out[i]
                        mag = fin + fout
                        net = fin - fout
                        pulse = 0.88 + 0.12 * ti.sin(now_ms * 0.0028 + ti.cast(i, ti.f32) * 0.00001)
                        mag_norm = ti.max(0.0, ti.min(1.0, (mag - FLOW_MIN) * FLOW_SCALE)) if mag > FLOW_MIN else 0.0
                        intensity = (mag_norm ** 1.9) * ti.max(0.0, ti.min(1.0, pulse))
                        src = net < 0
                        hr = 50.0 if src else 255.0
                        hg = 210.0 if src else 190.0
                        hb = 255.0 if src else 70.0

                        # gene+energy 底色（与 JS transfer 视图一致的思路，但不做完整 LUT：这里直接走简单映射）
                        e = ti.max(0.0, energy[i])
                        gv = ti.max(0.0, ti.min(1.0, gene[i]))
                        base_v = ti.min(0.35, biomass[i] * 0.35 + ti.min(0.08, e * 0.0018))
                        g_idx = ti.cast(gv * 255.0, ti.i32)
                        g_idx = ti.max(0, ti.min(255, g_idx))
                        e_idx = ti.cast((ti.min(e, SAT_E_MAX) / SAT_E_MAX) * 63.0, ti.i32)
                        e_idx = ti.max(0, ti.min(63, e_idx))
                        lut_val = self.hsv_lut[g_idx, e_idx]
                        rr = lut_val[0] * base_v * 0.65
                        gg = lut_val[1] * base_v * 0.65
                        bb = lut_val[2] * base_v * 0.65

                        rr = rr + (hr / 255.0 - rr) * intensity
                        gg = gg + (hg / 255.0 - gg) * intensity
                        bb = bb + (hb / 255.0 - bb) * intensity
                        r = ti.max(0.0, ti.min(1.0, rr)) * 255.0
                        g = ti.max(0.0, ti.min(1.0, gg)) * 255.0
                        b = ti.max(0.0, ti.min(1.0, bb)) * 255.0
                else:  # eco
                    if t == ti.u8(CellType.EMPTY):
                        r = 5.0 + light_norm * 14.0 + loss_norm * 14.0
                        g = 8.0 + light_norm * 21.0 - loss_norm * 5.0
                        b = 12.0 + light_norm * 28.0 - loss_norm * 10.0
                    else:
                        e = ti.max(0.0, energy[i])
                        gv = ti.max(0.0, ti.min(1.0, gene[i]))
                        g_idx = ti.cast(gv * 255.0, ti.i32)
                        g_idx = ti.max(0, ti.min(255, g_idx))
                        e_idx = ti.cast((e / SAT_E_MAX) * 63.0, ti.i32) if e < SAT_E_MAX else 63
                        e_idx = ti.max(0, ti.min(63, e_idx))
                        lut_val = self.hsv_lut[g_idx, e_idx]
                        value = ti.min(1.0, biomass[i] * 0.9 + ti.min(0.12, e * 0.0025))
                        rr = lut_val[0] * value
                        gg = lut_val[1] * value
                        bb = lut_val[2] * value
                        if show_aging_glow == 1 and biomass[i] > 0 and age[i] > 0:
                            cell_max_age = 3.0 + (1.0 - gv) * 1.5
                            sen = (age[i] - cell_max_age * 0.7) / (cell_max_age * 0.3)
                            if sen > 0:
                                glow = ti.min(1.0, sen) * 0.85
                                rr = ti.min(1.0, rr + (1.0 - rr) * glow)
                                gg *= (1.0 - glow)
                                bb *= (1.0 - glow)
                        r = rr * 255.0
                        g = gg * 255.0
                        b = bb * 255.0

            self.rgba[py, px] = ti.Vector([
                ti.cast(ti.max(0.0, ti.min(255.0, r)), ti.u8),
                ti.cast(ti.max(0.0, ti.min(255.0, g)), ti.u8),
                ti.cast(ti.max(0.0, ti.min(255.0, b)), ti.u8),
                ti.u8(255),
            ])

    def render_view(self, world, *,
                    sx: float, sy: float, sw: float, sh: float,
                    view_mode: str = "eco",
                    show_aging_glow: bool = False,
                    now_ms: float = 0.0):
        # mode map
        mode_i = 0
        if view_mode == "terrainLight":
            mode_i = 1
        elif view_mode == "terrainLoss":
            mode_i = 2
        elif view_mode == "terrainMix":
            mode_i = 3
        elif view_mode == "transfer":
            mode_i = 4

        front = world.front
        terrain = world.terrain
        flow_in = getattr(world, "flow_in", None)
        flow_out = getattr(world, "flow_out", None)
        # fast tick 的 flow 暂未填充；但为了 transfer 模式接口一致，缺失时给 0 缓冲
        if flow_in is None:
            if self._zero_flow is None or self._zero_flow_size != int(world.size):
                self._zero_flow = ti.ndarray(dtype=ti.f32, shape=(int(world.size),))
                self._zero_flow.fill(0)
                self._zero_flow_size = int(world.size)
            flow_in = self._zero_flow
        if flow_out is None:
            if self._zero_flow is None or self._zero_flow_size != int(world.size):
                self._zero_flow = ti.ndarray(dtype=ti.f32, shape=(int(world.size),))
                self._zero_flow.fill(0)
                self._zero_flow_size = int(world.size)
            flow_out = self._zero_flow

        self._render_view(
            int(world.width), int(world.height),
            float(sx), float(sy), float(sw), float(sh),
            front.type, front.biomass, front.energy, front.gene, front.age,
            terrain.light, terrain.loss,
            float(getattr(terrain, "light_min", getattr(terrain, "lightMin", 0.0))),
            float(getattr(terrain, "light_max", getattr(terrain, "lightMax", 1.0))),
            float(getattr(terrain, "loss_min", getattr(terrain, "lossMin", 0.0))),
            float(getattr(terrain, "loss_max", getattr(terrain, "lossMax", 1.0))),
            flow_in, flow_out,
            int(mode_i),
            1 if show_aging_glow else 0,
            float(now_ms),
        )

    def get_rgba(self) -> np.ndarray:
        return self.rgba.to_numpy()
