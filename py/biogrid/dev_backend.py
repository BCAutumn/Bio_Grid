import argparse
import json
import os
import random
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import numpy as np
import taichi as ti

from .config import Config
from .render import TaichiViewRenderer
from .tick_fast_ti import FastTicker, get_stats_fast, tick_fast
from .world_ti import WorldTI


_TI_READY = False
_TI_INIT_LOCK = threading.Lock()
_TI_RUNTIME_LOCK = threading.Lock()

EMPTY = 0
PLANT = 1
WALL = 3
BRUSH_LIFE = 0
BRUSH_DISTURB = 1
BRUSH_ANNIHILATE = 2
BRUSH_WALL = 3
BRUSH_ERASE = 4
SHAPE_CIRCLE = 0
SHAPE_SQUARE = 1
SHAPE_RECT = 2
SHAPE_TRIANGLE = 3
LIGHT_MIN = 0.0
LIGHT_MAX = 2.0
LOSS_MIN = 1.0
LOSS_MAX = 25.0


def _ensure_taichi():
    global _TI_READY
    if _TI_READY:
        return
    with _TI_INIT_LOCK:
        if _TI_READY:
            return
        arch = (os.environ.get("BIOGRID_TAICHI_ARCH") or "gpu").lower()
        if arch in ("cpu",):
            ti.init(arch=ti.cpu, default_fp=ti.f32)
        else:
            # GPU 优先（macOS 会走 Metal）
            ti.init(arch=ti.gpu, default_fp=ti.f32)
        _TI_READY = True


@ti.func
def _inside_brush(dx: ti.i32, dy: ti.i32, r: ti.i32, shape: ti.i32) -> ti.i32:
    inside = ti.i32(0)
    if shape == SHAPE_SQUARE:
        if ti.abs(dx) <= r and ti.abs(dy) <= r:
            inside = ti.i32(1)
    elif shape == SHAPE_RECT:
        if ti.abs(dx) <= r and ti.abs(dy) <= ti.cast(ti.f32(r) * 0.5, ti.i32):
            inside = ti.i32(1)
    elif shape == SHAPE_TRIANGLE:
        fdy = ti.cast(dy, ti.f32)
        fr = ti.max(1.0, ti.cast(r, ti.f32))
        if fdy >= -fr and fdy <= fr * 0.5:
            half_w = fr * (1.0 - (fdy + fr) / (1.5 * fr))
            if ti.abs(ti.cast(dx, ti.f32)) <= half_w and half_w > 0:
                inside = ti.i32(1)
    else:
        if dx * dx + dy * dy <= r * r:
            inside = ti.i32(1)
    return inside


@ti.kernel
def _apply_brush(
    a_type: ti.types.ndarray(dtype=ti.u8),
    a_biomass: ti.types.ndarray(dtype=ti.f32),
    a_energy: ti.types.ndarray(dtype=ti.f32),
    a_gene: ti.types.ndarray(dtype=ti.f32),
    a_age: ti.types.ndarray(dtype=ti.f32),
    b_type: ti.types.ndarray(dtype=ti.u8),
    b_biomass: ti.types.ndarray(dtype=ti.f32),
    b_energy: ti.types.ndarray(dtype=ti.f32),
    b_gene: ti.types.ndarray(dtype=ti.f32),
    b_age: ti.types.ndarray(dtype=ti.f32),
    width: ti.i32,
    height: ti.i32,
    cx: ti.i32,
    cy: ti.i32,
    radius: ti.i32,
    mode: ti.i32,
    shape: ti.i32,
    gene_v: ti.f32,
    energy_v: ti.f32,
):
    # mode: 0 life(seed), 1 disturb, 2 annihilate, 3 wall, 4 erase
    e = ti.max(0.0, energy_v)
    g = ti.min(1.0, ti.max(0.0, gene_v))
    max_b = 1.8 - g * 0.8
    seed_bio = ti.min(1.0, ti.max(0.0, max_b))
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if _inside_brush(dx, dy, radius, shape) == 0:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            i = y * width + x
            if mode == 0:
                # life 不覆盖墙体（与 JS applyBrush 对齐）
                if a_type[i] == ti.u8(WALL):
                    continue
                a_type[i] = PLANT
                a_biomass[i] = seed_bio
                a_energy[i] = e
                a_gene[i] = g
                a_age[i] = 0.0
            elif mode == 1:
                # JS disturb: 仅把能量置零
                a_energy[i] = 0.0
            elif mode == 2:
                a_type[i] = EMPTY
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
            elif mode == 3:
                a_type[i] = WALL
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
            else:
                a_type[i] = EMPTY
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
    # 同步写回 back（简单做法：对同一圈复制一次）
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if _inside_brush(dx, dy, radius, shape) == 0:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            i = y * width + x
            b_type[i] = a_type[i]
            b_biomass[i] = a_biomass[i]
            b_energy[i] = a_energy[i]
            b_gene[i] = a_gene[i]
            b_age[i] = a_age[i]


@ti.kernel
def _apply_terrain_brush(
    terrain: ti.types.ndarray(dtype=ti.f32),
    width: ti.i32,
    height: ti.i32,
    cx: ti.i32,
    cy: ti.i32,
    radius: ti.i32,
    shape: ti.i32,
    delta: ti.f32,
    clamp_min: ti.f32,
    clamp_max: ti.f32,
):
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if _inside_brush(dx, dy, radius, shape) == 0:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0 or x >= width or y >= height:
                continue
            i = y * width + x
            v = terrain[i] + delta
            terrain[i] = ti.max(clamp_min, ti.min(clamp_max, v))


def _shape_id(shape: Any) -> int:
    s = str(shape or "circle")
    if s == "square":
        return SHAPE_SQUARE
    if s == "rect":
        return SHAPE_RECT
    if s == "triangle":
        return SHAPE_TRIANGLE
    return SHAPE_CIRCLE


def _sync_front_back(world: WorldTI):
    world.back.type.copy_from(world.front.type)
    world.back.biomass.copy_from(world.front.biomass)
    world.back.energy.copy_from(world.front.energy)
    world.back.gene.copy_from(world.front.gene)
    world.back.age.copy_from(world.front.age)


def _set_cell_type(
    arr_type: np.ndarray,
    arr_bio: np.ndarray,
    arr_energy: np.ndarray,
    arr_gene: np.ndarray,
    arr_age: np.ndarray,
    w: int,
    h: int,
    x: int,
    y: int,
    t: int,
):
    if x < 0 or y < 0:
        return
    if x >= w:
        return
    if y >= h:
        return
    i = y * w + x
    arr_type[i] = t
    if t != PLANT:
        arr_bio[i] = 0.0
        arr_energy[i] = 0.0
        arr_gene[i] = 0.0
        arr_age[i] = 0.0


def _load_preset_taichi(world: WorldTI, preset_name: str):
    world.reset()
    if preset_name == "empty":
        return

    w = world.width
    h = world.height
    size = w * h
    cx = w // 2
    cy = h // 2
    t = np.zeros(size, dtype=np.uint8)
    bio = np.zeros(size, dtype=np.float32)
    en = np.zeros(size, dtype=np.float32)
    ge = np.zeros(size, dtype=np.float32)
    age = np.zeros(size, dtype=np.float32)

    if preset_name == "fourRooms":
        for y in range(h):
            for x in range(w):
                if abs(x - cx) < 2 or abs(y - cy) < 2:
                    if abs(x - cx) < 2 and abs(y - cy) > 10 and y % 30 < 6:
                        continue
                    if abs(y - cy) < 2 and abs(x - cx) > 10 and x % 30 < 6:
                        continue
                    i = y * w + x
                    t[i] = WALL
    elif preset_name == "fiveZones":
        terrain_light = np.zeros(size, dtype=np.float32)
        terrain_loss = np.zeros(size, dtype=np.float32)
        center_x = (w - 1) * 0.5
        center_y = (h - 1) * 0.5
        half_w = max(1.0, w * 0.5)
        half_h = max(1.0, h * 0.5)
        center_diamond_ratio = np.sqrt(0.1)

        for y in range(h):
            for x in range(w):
                ux = abs((x - center_x) / half_w)
                uy = abs((y - center_y) / half_h)
                i = y * w + x
                if ux + uy <= center_diamond_ratio:
                    terrain_light[i], terrain_loss[i] = 1.0, 1.0
                elif x <= center_x and y <= center_y:
                    terrain_light[i], terrain_loss[i] = 0.0, 1.0
                elif x <= center_x and y > center_y:
                    terrain_light[i], terrain_loss[i] = 2.0, 25.0
                elif x > center_x and y <= center_y:
                    terrain_light[i], terrain_loss[i] = 2.0, 1.0
                else:
                    terrain_light[i], terrain_loss[i] = 0.0, 25.0
        world.terrain.light.from_numpy(terrain_light)
        world.terrain.loss.from_numpy(terrain_loss)
        world.terrain.recompute_ranges()

        def draw_dashed_wall(x0: int, y0: int, x1: int, y1: int, dash_len: int = 10, gap_len: int = 12):
            dx = x1 - x0
            dy = y1 - y0
            steps = max(abs(dx), abs(dy))
            if steps <= 0:
                return
            period = max(2, dash_len + gap_len)
            for s in range(steps + 1):
                if s % period >= dash_len:
                    continue
                p = s / steps
                x = int(round(x0 + dx * p))
                y = int(round(y0 + dy * p))
                _set_cell_type(t, bio, en, ge, age, w, h, x, y, WALL)

        left = (round(center_x - half_w * center_diamond_ratio), round(center_y))
        top = (round(center_x), round(center_y - half_h * center_diamond_ratio))
        right = (round(center_x + half_w * center_diamond_ratio), round(center_y))
        bottom = (round(center_x), round(center_y + half_h * center_diamond_ratio))
        draw_dashed_wall(left[0], left[1], top[0], top[1])
        draw_dashed_wall(top[0], top[1], right[0], right[1])
        draw_dashed_wall(right[0], right[1], bottom[0], bottom[1])
        draw_dashed_wall(bottom[0], bottom[1], left[0], left[1])
    elif preset_name == "hourglass":
        pad = 2
        ww = w - pad * 2
        hh = h - pad * 2
        for y0 in range(hh):
            tt = 0.0 if hh <= 1 else y0 / (hh - 1)
            squeeze = abs(tt - 0.5) * 2
            margin = int((ww * 0.38) * (1 - squeeze))
            left = pad + margin
            right = w - 1 - pad - margin
            y = y0 + pad
            if y == pad or y == h - 1 - pad:
                continue
            _set_cell_type(t, bio, en, ge, age, w, h, left, y, WALL)
            _set_cell_type(t, bio, en, ge, age, w, h, right, y, WALL)
        for x in range(pad + int(ww * 0.44), pad + int(ww * 0.56) + 1):
            _set_cell_type(t, bio, en, ge, age, w, h, x, cy, WALL)
    elif preset_name == "rings":
        step = 14
        max_ring = min(w // 2, h // 2) - 2
        rng = random.Random()
        for r in range(step, max_ring + 1, step):
            x0 = cx - r
            x1 = cx + r
            y0 = cy - r
            y1 = cy + r
            for x in range(x0, x1 + 1):
                _set_cell_type(t, bio, en, ge, age, w, h, x, y0, WALL)
                _set_cell_type(t, bio, en, ge, age, w, h, x, y1, WALL)
            for y in range(y0, y1 + 1):
                _set_cell_type(t, bio, en, ge, age, w, h, x0, y, WALL)
                _set_cell_type(t, bio, en, ge, age, w, h, x1, y, WALL)
            door_half = 1
            door_side = rng.randrange(4)
            span = max(1, 2 * r - 1)
            center_pos = 1 if r <= 1 else 1 + (rng.randrange(span) % span)
            if door_side == 0:
                for dx in range(-door_half, door_half + 1):
                    _set_cell_type(t, bio, en, ge, age, w, h, x0 + center_pos + dx, y0, EMPTY)
            elif door_side == 1:
                for dx in range(-door_half, door_half + 1):
                    _set_cell_type(t, bio, en, ge, age, w, h, x0 + center_pos + dx, y1, EMPTY)
            elif door_side == 2:
                for dy in range(-door_half, door_half + 1):
                    _set_cell_type(t, bio, en, ge, age, w, h, x0, y0 + center_pos + dy, EMPTY)
            else:
                for dy in range(-door_half, door_half + 1):
                    _set_cell_type(t, bio, en, ge, age, w, h, x1, y0 + center_pos + dy, EMPTY)
    elif preset_name == "verticalGradient":
        terrain_light = np.zeros(size, dtype=np.float32)
        terrain_loss = np.zeros(size, dtype=np.float32)
        top_band = 0.05
        bottom_band = 0.02
        denom = max(1e-6, 1 - top_band - bottom_band)

        def smoothstep(v: float) -> float:
            return v * v * (3 - 2 * v)

        for y in range(h):
            v = 0.0 if h <= 1 else y / (h - 1)
            if v <= top_band:
                tt = 0.0
            elif v >= 1 - bottom_band:
                tt = 1.0
            else:
                tt = smoothstep((v - top_band) / denom)
            light = LIGHT_MAX + (LIGHT_MIN - LIGHT_MAX) * tt
            loss = LOSS_MIN + (LOSS_MAX - LOSS_MIN) * tt
            row = y * w
            terrain_light[row:row + w] = light
            terrain_loss[row:row + w] = loss
        world.terrain.light.from_numpy(terrain_light)
        world.terrain.loss.from_numpy(terrain_loss)
        world.terrain.recompute_ranges()
    elif preset_name == "maze":
        t.fill(WALL)
        scale = 3
        cells_w = int((w - 2) / scale)
        cells_h = int((h - 2) / scale)
        if cells_w > 1 and cells_h > 1:
            cell_count = cells_w * cells_h
            visited = np.zeros(cell_count, dtype=np.uint8)
            stack = []

            def open_at(gx: int, gy: int):
                if gx < 0 or gy < 0 or gx >= w or gy >= h:
                    return
                i = gy * w + gx
                t[i] = EMPTY
                bio[i] = 0.0
                en[i] = 0.0
                ge[i] = 0.0
                age[i] = 0.0

            def cell_to_grid(cx0: int, cy0: int):
                return (1 + cx0 * scale, 1 + cy0 * scale)

            def carve_room(cx0: int, cy0: int):
                gx, gy = cell_to_grid(cx0, cy0)
                open_at(gx, gy)
                open_at(gx + 1, gy)
                open_at(gx, gy + 1)
                open_at(gx + 1, gy + 1)

            def carve_door(from_cx: int, from_cy: int, dx: int, dy: int):
                gx, gy = cell_to_grid(from_cx, from_cy)
                if dx == 1:
                    open_at(gx + 2, gy)
                    open_at(gx + 2, gy + 1)
                elif dx == -1:
                    open_at(gx - 1, gy)
                    open_at(gx - 1, gy + 1)
                elif dy == 1:
                    open_at(gx, gy + 2)
                    open_at(gx + 1, gy + 2)
                elif dy == -1:
                    open_at(gx, gy - 1)
                    open_at(gx + 1, gy - 1)

            dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)]
            start_cx = random.randrange(cells_w)
            start_cy = random.randrange(cells_h)
            start = start_cy * cells_w + start_cx
            visited[start] = 1
            stack.append(start)
            carve_room(start_cx, start_cy)
            while stack:
                current = stack[-1]
                cx0 = current % cells_w
                cy0 = current // cells_w
                opts = []
                for d, (dx, dy) in enumerate(dirs):
                    nx = cx0 + dx
                    ny = cy0 + dy
                    if nx < 0 or ny < 0 or nx >= cells_w or ny >= cells_h:
                        continue
                    ni = ny * cells_w + nx
                    if visited[ni]:
                        continue
                    opts.append((d, ni))
                if not opts:
                    stack.pop()
                    continue
                d, nxt = random.choice(opts)
                visited[nxt] = 1
                stack.append(nxt)
                nx = nxt % cells_w
                ny = nxt // cells_w
                dx = nx - cx0
                dy = ny - cy0
                carve_door(cx0, cy0, dx, dy)
                carve_room(nx, ny)

            ex, _ = cell_to_grid(0, 0)
            open_at(ex, 0)
            open_at(ex + 1, 0)
            open_at(ex, 1)
            open_at(ex + 1, 1)
            xx, _ = cell_to_grid(cells_w - 1, cells_h - 1)
            open_at(xx, h - 1)
            open_at(xx + 1, h - 1)
            open_at(xx, h - 2)
            open_at(xx + 1, h - 2)

    world.front.type.from_numpy(t)
    world.front.biomass.from_numpy(bio)
    world.front.energy.from_numpy(en)
    world.front.gene.from_numpy(ge)
    world.front.age.from_numpy(age)
    _sync_front_back(world)


class SimSession:
    def __init__(self):
        self.world: Optional[WorldTI] = None
        self.ticker: Optional[FastTicker] = None
        self.renderer: Optional[TaichiViewRenderer] = None

        self.running = True
        self.ticks_per_second = 300.0
        self.acc = 0.0
        self.last_ts = time.perf_counter()
        self.max_steps_per_frame = 160
        self.sim_loop_interval_s = 0.004
        self._sim_stop = threading.Event()
        self._sim_thread: Optional[threading.Thread] = None
        self.last_frame_tick = 0

        self.view = {"sx": 0.0, "sy": 0.0, "sw": 1.0, "sh": 1.0}
        self.view_mode = "eco"
        self.show_aging_glow = False

        self._last_stats_ts = 0.0
        self._stats_cache = {
            "plant_count": 0,
            "total_biomass": 0.0,
            "avg_gene": 0.0,
            "normalized_biomass": 0.0,
            "senescent_ratio": 0.0,
        }
        self.terrain_history_limit = 30
        self.terrain_history = {"undo": [], "redo": []}

    def ensure_world(self, w: int, h: int):
        if self.world and self.world.width == w and self.world.height == h:
            return
        cfg = Config()
        self.world = WorldTI(w, h, cfg)
        self.world.set_terrain_linear()
        self.ticker = FastTicker(w, h)
        self.view = {"sx": 0.0, "sy": 0.0, "sw": float(w), "sh": float(h)}
        self.reset_terrain_history()

    def ensure_renderer(self, out_w: int, out_h: int):
        if self.renderer and self.renderer.out_w == out_w and self.renderer.out_h == out_h:
            return
        self.renderer = TaichiViewRenderer(out_w, out_h)

    def start_background_loop(self):
        if self._sim_thread and self._sim_thread.is_alive():
            return
        self._sim_stop.clear()
        self._sim_thread = threading.Thread(target=self._background_loop, name="biogrid-sim-loop", daemon=True)
        self._sim_thread.start()

    def stop_background_loop(self):
        self._sim_stop.set()
        t = self._sim_thread
        if t and t.is_alive():
            t.join(timeout=1.0)
        self._sim_thread = None

    def _background_loop(self):
        while not self._sim_stop.is_set():
            with _TI_RUNTIME_LOCK:
                self.step_if_needed()
                self.maybe_update_stats()
            self._sim_stop.wait(self.sim_loop_interval_s)

    def step_if_needed(self):
        if not self.world or not self.ticker:
            return 0
        now = time.perf_counter()
        dt = now - self.last_ts
        self.last_ts = now
        if dt < 0:
            dt = 0
        if dt > 0.25:
            dt = 0.25
        steps = 0
        if self.running:
            self.acc = min(256.0, self.acc + dt * float(self.ticks_per_second))
            while self.acc >= 1.0 and steps < self.max_steps_per_frame:
                tick_fast(self.world, self.ticker)
                self.acc -= 1.0
                steps += 1
        return steps

    def consume_steps_since_frame(self) -> int:
        if not self.world:
            return 0
        tick = int(self.world.tick)
        delta = tick - int(self.last_frame_tick)
        self.last_frame_tick = tick
        return delta if delta > 0 else 0

    def maybe_update_stats(self):
        if not self.world:
            return
        now = time.perf_counter()
        if now - self._last_stats_ts < 0.8:
            return
        self._last_stats_ts = now
        try:
            self._stats_cache = get_stats_fast(self.world)
        except Exception:
            # stats 是非关键路径，失败就保持旧值
            pass

    def terrain_history_state(self, action: str = "sync"):
        return {
            "type": "terrainHistoryState",
            "action": action,
            "canUndo": len(self.terrain_history["undo"]) > 0,
            "canRedo": len(self.terrain_history["redo"]) > 0,
        }

    def reset_terrain_history(self):
        self.terrain_history["undo"].clear()
        self.terrain_history["redo"].clear()

    def _clone_state(self):
        if not self.world:
            return None
        w = self.world
        return {
            "front_type": w.front.type.to_numpy(),
            "front_biomass": w.front.biomass.to_numpy(),
            "front_energy": w.front.energy.to_numpy(),
            "front_gene": w.front.gene.to_numpy(),
            "front_age": w.front.age.to_numpy(),
            "back_type": w.back.type.to_numpy(),
            "back_biomass": w.back.biomass.to_numpy(),
            "back_energy": w.back.energy.to_numpy(),
            "back_gene": w.back.gene.to_numpy(),
            "back_age": w.back.age.to_numpy(),
            "terrain_light": w.terrain.light.to_numpy(),
            "terrain_loss": w.terrain.loss.to_numpy(),
            "terrain_light_min": float(w.terrain.light_min),
            "terrain_light_max": float(w.terrain.light_max),
            "terrain_loss_min": float(w.terrain.loss_min),
            "terrain_loss_max": float(w.terrain.loss_max),
            "time": float(w.time),
            "day": float(w.day),
            "sunlight": float(w.sunlight),
            "tick": int(w.tick),
        }

    def _restore_state(self, snap: dict[str, Any]):
        if not self.world:
            return
        w = self.world
        w.front.type.from_numpy(snap["front_type"])
        w.front.biomass.from_numpy(snap["front_biomass"])
        w.front.energy.from_numpy(snap["front_energy"])
        w.front.gene.from_numpy(snap["front_gene"])
        w.front.age.from_numpy(snap["front_age"])
        w.back.type.from_numpy(snap["back_type"])
        w.back.biomass.from_numpy(snap["back_biomass"])
        w.back.energy.from_numpy(snap["back_energy"])
        w.back.gene.from_numpy(snap["back_gene"])
        w.back.age.from_numpy(snap["back_age"])
        w.terrain.light.from_numpy(snap["terrain_light"])
        w.terrain.loss.from_numpy(snap["terrain_loss"])
        w.terrain.light_min = float(snap["terrain_light_min"])
        w.terrain.light_max = float(snap["terrain_light_max"])
        w.terrain.loss_min = float(snap["terrain_loss_min"])
        w.terrain.loss_max = float(snap["terrain_loss_max"])
        w.time = float(snap["time"])
        w.day = float(snap["day"])
        w.sunlight = float(snap["sunlight"])
        w.tick = int(snap["tick"])
        self.acc = 0.0
        self._last_stats_ts = 0.0

    def push_terrain_history(self, clear_redo: bool = True):
        snap = self._clone_state()
        if not snap:
            return
        undo = self.terrain_history["undo"]
        redo = self.terrain_history["redo"]
        undo.append(snap)
        if len(undo) > self.terrain_history_limit:
            del undo[0]
        if clear_redo:
            redo.clear()

    def undo_terrain_history(self) -> str:
        undo = self.terrain_history["undo"]
        redo = self.terrain_history["redo"]
        if not undo:
            return "undo-empty"
        current = self._clone_state()
        prev = undo.pop()
        if current:
            redo.append(current)
        self._restore_state(prev)
        return "undo"

    def redo_terrain_history(self) -> str:
        undo = self.terrain_history["undo"]
        redo = self.terrain_history["redo"]
        if not redo:
            return "redo-empty"
        current = self._clone_state()
        nxt = redo.pop()
        if current:
            undo.append(current)
        self._restore_state(nxt)
        return "redo"


SESSION = SimSession()


class Handler(BaseHTTPRequestHandler):
    server_version = "BioGridDevBackend/0.1"

    def _send_json(self, status: int, payload: dict):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, status: int, content_type: str, data: bytes):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except Exception:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):  # noqa: N802
        if self.path in ("/health", "/api/health"):
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "biogrid-dev-backend",
                    "time": time.time(),
                },
            )
            return
        if self.path == "/api/frame":
            try:
                with _TI_RUNTIME_LOCK:
                    steps = SESSION.consume_steps_since_frame()
                    SESSION.maybe_update_stats()
                    if not SESSION.world or not SESSION.renderer:
                        self._send_json(400, {"ok": False, "error": "not_initialized"})
                        return

                    w = SESSION.world.width
                    h = SESSION.world.height
                    v = SESSION.view
                    # 避免把超大 now_ms(Unix ms) 传进 ti.f32 导致精度/溢出问题
                    now_ms = (time.perf_counter() * 1000.0) % 1_000_000.0
                    SESSION.renderer.render_view(
                        SESSION.world,
                        sx=float(v["sx"]),
                        sy=float(v["sy"]),
                        sw=float(v["sw"]),
                        sh=float(v["sh"]),
                        view_mode=str(SESSION.view_mode),
                        show_aging_glow=bool(SESSION.show_aging_glow),
                        now_ms=float(now_ms),
                    )
                    rgba = SESSION.renderer.get_rgba()  # (H,W,4) uint8
                    meta = {
                        "ok": True,
                        "engine": "taichi",
                        "world": {"width": int(w), "height": int(h)},
                        "canvas": {"width": int(SESSION.renderer.out_w), "height": int(SESSION.renderer.out_h)},
                        "sim": {
                            "running": bool(SESSION.running),
                            "ticksPerSecond": float(SESSION.ticks_per_second),
                            "backlog": float(SESSION.acc),
                            "steps": int(steps),
                            "time": float(SESSION.world.time),
                            "day": float(SESSION.world.day),
                            "sunlight": float(SESSION.world.sunlight),
                            "tick": int(SESSION.world.tick),
                        },
                        "stats": SESSION._stats_cache,
                        "view": {**v, "viewMode": str(SESSION.view_mode), "showAgingGlow": bool(SESSION.show_aging_glow)},
                    }
                    meta_bytes = json.dumps(meta, ensure_ascii=False).encode("utf-8")
                    header = struct.pack("<I", len(meta_bytes))
                    payload = header + meta_bytes + rgba.tobytes(order="C")
                    self._send_bytes(200, "application/octet-stream", payload)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": "frame_failed", "message": str(e)})
            return
        self._send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path == "/api/message":
            try:
                msg = self._read_json()
                mtype = msg.get("type")
                if not isinstance(mtype, str):
                    self._send_json(400, {"ok": False, "error": "bad_message"})
                    return

                if mtype == "init":
                    with _TI_RUNTIME_LOCK:
                        w = int(msg.get("width") or 180)
                        h = int(msg.get("height") or 180)
                        out_w = int(msg.get("canvasWidth") or 720)
                        out_h = int(msg.get("canvasHeight") or 720)
                        seed_count = int(msg.get("seedCount") or 0)
                        tps = float(msg.get("ticksPerSecond") or 300.0)
                        sun_speed = float(msg.get("sunSpeed") or 0.014)
                        polar = bool(msg.get("polarDay") or False)
                        running = msg.get("running") is not False

                        SESSION.ensure_world(w, h)
                        SESSION.ensure_renderer(out_w, out_h)
                        assert SESSION.world is not None

                        SESSION.world.config.sunSpeed = max(0.004, min(0.12, sun_speed))
                        SESSION.world.config.polarDay = bool(polar)
                        SESSION.ticks_per_second = max(0.2, min(1920.0, tps))
                        SESSION.running = bool(running)
                        SESSION.acc = 0.0
                        SESSION.last_ts = time.perf_counter()
                        SESSION.last_frame_tick = int(SESSION.world.tick)
                        SESSION.view = {"sx": 0.0, "sy": 0.0, "sw": float(w), "sh": float(h)}
                        SESSION.view_mode = "eco"
                        SESSION.show_aging_glow = False
                        SESSION.reset_terrain_history()

                        if seed_count > 0:
                            SESSION.world.seed_plants(seed_count, seed=42)

                        self._send_json(
                            200,
                            {
                                "ok": True,
                                "type": "ready",
                                "engine": "taichi",
                                "terrainHistoryState": SESSION.terrain_history_state("init"),
                            },
                        )
                    return

                if mtype == "setCanvasSize":
                    with _TI_RUNTIME_LOCK:
                        out_w = int(msg.get("width") or 720)
                        out_h = int(msg.get("height") or 720)
                        SESSION.ensure_renderer(out_w, out_h)
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setView":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.view = {
                            "sx": float(msg.get("sx") or 0.0),
                            "sy": float(msg.get("sy") or 0.0),
                            "sw": float(msg.get("sw") or SESSION.world.width),
                            "sh": float(msg.get("sh") or SESSION.world.height),
                        }
                        vm = msg.get("viewMode")
                        if isinstance(vm, str):
                            SESSION.view_mode = vm
                            if SESSION.world:
                                SESSION.world.config.trackFlow = vm == "transfer"
                        sag = msg.get("showAgingGlow")
                        if isinstance(sag, bool):
                            SESSION.show_aging_glow = sag
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setRunning":
                    with _TI_RUNTIME_LOCK:
                        SESSION.running = bool(msg.get("running"))
                        SESSION.last_ts = time.perf_counter()
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setTicksPerSecond":
                    with _TI_RUNTIME_LOCK:
                        v = float(msg.get("value") or SESSION.ticks_per_second)
                        SESSION.ticks_per_second = max(0.2, min(1920.0, v))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setSunSpeed":
                    with _TI_RUNTIME_LOCK:
                        if SESSION.world:
                            v = float(msg.get("value") or SESSION.world.config.sunSpeed)
                            SESSION.world.config.sunSpeed = max(0.004, min(0.12, v))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setPolarDayMode":
                    with _TI_RUNTIME_LOCK:
                        if SESSION.world:
                            SESSION.world.config.polarDay = bool(msg.get("value"))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "setShowAgingGlow":
                    with _TI_RUNTIME_LOCK:
                        SESSION.show_aging_glow = bool(msg.get("value"))
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "reset":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.world.reset()
                        SESSION.acc = 0.0
                        SESSION.last_frame_tick = int(SESSION.world.tick)
                        SESSION.reset_terrain_history()
                        self._send_json(200, {"ok": True, "terrainHistoryState": SESSION.terrain_history_state("reset")})
                    return

                if mtype == "randomSeed":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        count = int(msg.get("count") or 160)
                        SESSION.world.seed_plants(count, seed=42)
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "applyBrush":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        cx = int(msg.get("cx") or 0)
                        cy = int(msg.get("cy") or 0)
                        radius = int(msg.get("radius") or 3)
                        mode = msg.get("mode") or "life"
                        options_raw = msg.get("options")
                        options = options_raw if isinstance(options_raw, dict) else {}
                        gene_raw = options.get("gene", 0.5)
                        energy_raw = options.get("energy", 24.0)
                        try:
                            gene_v = float(0.5 if gene_raw is None else gene_raw)
                        except Exception:
                            gene_v = 0.5
                        try:
                            energy_v = float(24.0 if energy_raw is None else energy_raw)
                        except Exception:
                            energy_v = 24.0
                        shape_i = _shape_id(options.get("shape") or "circle")
                        mode_i = BRUSH_LIFE
                        if mode == "disturb":
                            mode_i = BRUSH_DISTURB
                        elif mode == "annihilate":
                            mode_i = BRUSH_ANNIHILATE
                        elif mode == "wall":
                            mode_i = BRUSH_WALL
                        elif mode == "erase":
                            mode_i = BRUSH_ERASE
                        w = int(SESSION.world.width)
                        h = int(SESSION.world.height)
                        _apply_brush(
                            SESSION.world.front.type,
                            SESSION.world.front.biomass,
                            SESSION.world.front.energy,
                            SESSION.world.front.gene,
                            SESSION.world.front.age,
                            SESSION.world.back.type,
                            SESSION.world.back.biomass,
                            SESSION.world.back.energy,
                            SESSION.world.back.gene,
                            SESSION.world.back.age,
                            w,
                            h,
                            cx,
                            cy,
                            radius,
                            mode_i,
                            shape_i,
                            gene_v,
                            energy_v,
                        )
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "applyTerrainBrush":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        cx = int(msg.get("cx") or 0)
                        cy = int(msg.get("cy") or 0)
                        radius = int(msg.get("radius") or 3)
                        shape_i = _shape_id(msg.get("shape") or "circle")
                        channel = str(msg.get("channel") or "light")
                        delta = float(msg.get("delta") or 0.0)
                        terrain_arr = SESSION.world.terrain.loss if channel == "loss" else SESSION.world.terrain.light
                        clamp_min = LOSS_MIN if channel == "loss" else LIGHT_MIN
                        clamp_max = LOSS_MAX if channel == "loss" else LIGHT_MAX
                        _apply_terrain_brush(
                            terrain_arr,
                            int(SESSION.world.width),
                            int(SESSION.world.height),
                            cx,
                            cy,
                            max(1, radius),
                            shape_i,
                            delta,
                            clamp_min,
                            clamp_max,
                        )
                        SESSION.world.terrain.recompute_ranges()
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "resetTerrainUniform":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.world.terrain.light.fill(1.0)
                        SESSION.world.terrain.loss.fill(1.0)
                        SESSION.world.terrain.light_min = 1.0
                        SESSION.world.terrain.light_max = 1.0
                        SESSION.world.terrain.loss_min = 1.0
                        SESSION.world.terrain.loss_max = 1.0
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "loadPreset":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        preset_name = str(msg.get("presetName") or "empty")
                        _load_preset_taichi(SESSION.world, preset_name)
                        SESSION.acc = 0.0
                        SESSION.last_frame_tick = int(SESSION.world.tick)
                        self._send_json(200, {"ok": True})
                    return

                if mtype == "pushTerrainHistory":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        SESSION.push_terrain_history(clear_redo=msg.get("clearRedo") is not False)
                        self._send_json(200, {"ok": True, "terrainHistoryState": SESSION.terrain_history_state("push")})
                    return

                if mtype == "undoTerrainEdit":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        action = SESSION.undo_terrain_history()
                        self._send_json(200, {"ok": True, "terrainHistoryState": SESSION.terrain_history_state(action)})
                    return

                if mtype == "redoTerrainEdit":
                    with _TI_RUNTIME_LOCK:
                        if not SESSION.world:
                            self._send_json(400, {"ok": False, "error": "not_initialized"})
                            return
                        action = SESSION.redo_terrain_history()
                        self._send_json(200, {"ok": True, "terrainHistoryState": SESSION.terrain_history_state(action)})
                    return

                self._send_json(400, {"ok": False, "error": "unsupported_type", "type": mtype})
            except Exception as e:
                self._send_json(500, {"ok": False, "error": "message_failed", "message": str(e)})
            return

        self._send_json(404, {"ok": False, "error": "not_found"})

    def log_message(self, fmt, *args):  # quiet
        return


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Bio-Grid minimal dev backend (placeholder).")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    args = p.parse_args(argv)

    _ensure_taichi()
    SESSION.start_background_loop()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[backend] running at http://{args.host}:{args.port}  (GET /health)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SESSION.stop_background_loop()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
