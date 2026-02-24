"""Bio-Grid 交互式可视化窗口

说明：
- 该查看器本质上是“每帧生成一张像素图（纹理）并显示”，这是网格模拟最直接/最高效的可视化方式；
  它看起来像图片，但每一帧都在实时更新。
- 为了减少 macOS 上拖动/缩放窗口时的卡顿，这里使用 `ti.ui.Window`（GGUI，可 resizable），
  并把缩放交给 GPU（避免每帧把图像拷到 CPU 再放大）。
"""

import taichi as ti
import numpy as np
import time
from typing import Optional

from .state import World, CellType
from .config import Config
from .tick import tick, compute_stats
from .rng import SFC32
from .render import TaichiRenderer
from .world_ti import WorldTI
from .tick_fast_ti import FastTicker, tick_fast, get_stats_fast


@ti.kernel
def _brush_circle_fast(a_type: ti.types.ndarray(dtype=ti.u8),
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
                       cx: ti.i32, cy: ti.i32,
                       radius: ti.i32,
                       mode: ti.i32,
                       gene_v: ti.f32):
    # mode: 0 seed, 1 annihilate, 2 wall, 3 erase
    PLANT = ti.u8(CellType.PLANT)
    EMPTY = ti.u8(CellType.EMPTY)
    WALL = ti.u8(CellType.WALL)
    r2 = ti.cast(radius * radius, ti.i32)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > r2:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0:
                continue
            if x >= width:
                continue
            i = y * width + x
            # 因为我们不知道 height，这里用 i 越界风险：调用方保证坐标合法（viewer 会做边界裁剪）
            if mode == 0:
                a_type[i] = PLANT
                a_biomass[i] = 0.8
                a_energy[i] = 30.0
                a_gene[i] = gene_v
                a_age[i] = 0.0
            elif mode == 1:
                a_type[i] = EMPTY
                a_biomass[i] = 0.0
                a_energy[i] = 0.0
                a_gene[i] = 0.0
                a_age[i] = 0.0
            elif mode == 2:
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
    # 同步到 back（简单做法：整圈写两次）
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy > r2:
                continue
            x = cx + dx
            y = cy + dy
            if x < 0 or y < 0:
                continue
            if x >= width:
                continue
            i = y * width + x
            b_type[i] = a_type[i]
            b_biomass[i] = a_biomass[i]
            b_energy[i] = a_energy[i]
            b_gene[i] = a_gene[i]
            b_age[i] = a_age[i]


class BioGridApp:
    """Bio-Grid 交互式应用"""

    def __init__(self, world, seed: int = 12345, fast_mode: bool = True):
        self.world = world
        self.rng = SFC32(seed)
        self.renderer = TaichiRenderer(world.width, world.height)
        self.fast_mode = bool(fast_mode)
        self.fast_ticker = FastTicker(world.width, world.height) if self.fast_mode and isinstance(world, WorldTI) else None

        # 状态
        self.running = False
        # 默认直接运行（很多人会以为“卡住不动”，但其实只是暂停态）
        self.paused = False
        self.view_mode = 'eco'
        self.show_aging_glow = False
        # fast_mode 走 Taichi tick，可把默认 tps 拉高；strict_mode 仍保持保守默认
        self.target_tps = 960 if self.fast_mode else 10
        self._last_sim_step_time = 0.0
        self._tick_acc = 0.0

        # 统计
        self.tick_count = 0
        self.last_stats_time = time.time()
        self.actual_tps = 0.0
        self.frame_count = 0
        self.last_fps_time = time.time()
        self.actual_fps = 0.0
        self.last_stats = None
        self.last_stats_refresh_time = 0.0
        self.stats_refresh_interval = 0.5  # 秒：避免每帧扫描全网格
        self.history_biomass = []
        self.history_gene = []
        self.history_max = 300
        # UI controls (panel)
        self.ui_open = True
        self.brush_mode = 0  # 0 seed, 1 annihilate, 2 wall, 3 erase
        self.brush_radius = 6
        self.brush_gene = 0.5

    def run(self, window_scale: int = 3):
        """运行交互式窗口

        Args:
            window_scale: 窗口缩放倍数
        """
        window_scale = max(1, int(window_scale))
        window_height = self.world.height * window_scale
        sidebar_frac = 0.32
        sim_frac = 1.0 - sidebar_frac
        # 让“左侧模拟区”默认就是正方形：sim_w ~= window_height
        # sim_w = sim_frac * window_width  => window_width = window_height / sim_frac
        window_width = int(round(window_height / max(1e-6, sim_frac)))

        # 使用 GGUI。注意：不同 Taichi 版本对 Window 参数支持不一致；
        # 例如 1.7.4 上 `resizable` 参数不存在，这里做兼容回退。
        vsync = False if self.fast_mode else True
        try:
            window = ti.ui.Window('Bio-Grid', res=(window_width, window_height), vsync=vsync, resizable=True)
        except TypeError:
            window = ti.ui.Window('Bio-Grid', res=(window_width, window_height), vsync=vsync)
        canvas = window.get_canvas()
        gui = window.get_gui()
        display = None
        display_w = None
        display_h = None

        @ti.kernel
        def _blit_to_display(base_img: ti.template(),
                             out_img: ti.template(),
                             out_w: ti.i32, out_h: ti.i32,
                             sim_w: ti.i32,
                             sq: ti.i32,
                             offx: ti.i32,
                             offy: ti.i32):
            # 左侧：在 sim_w x out_h 内放一个“正方形视口”（sq x sq），最近邻采样（像素风清晰）
            #      视口之外用深色 letterbox 填充，保证永远不拉伸变形。
            # 右侧：固定深色背景（作为控制栏底色）
            bw = ti.cast(self.world.width, ti.f32)
            bh = ti.cast(self.world.height, ti.f32)
            ow = ti.cast(sq, ti.f32)
            oh = ti.cast(sq, ti.f32)
            for x, y in out_img:
                if x >= sim_w:
                    out_img[x, y] = ti.Vector([0.08, 0.08, 0.09])
                else:
                    # left-side letterbox
                    if (x < offx) or (x >= offx + sq) or (y < offy) or (y >= offy + sq):
                        out_img[x, y] = ti.Vector([0.05, 0.06, 0.08])
                    else:
                        lx = x - offx
                        ly = y - offy
                        sx = ti.cast(ti.floor((ti.cast(lx, ti.f32) + 0.5) * bw / ow), ti.i32)
                        sy = ti.cast(ti.floor((ti.cast(ly, ti.f32) + 0.5) * bh / oh), ti.i32)
                        sx = ti.max(0, ti.min(self.world.width - 1, sx))
                        sy = ti.max(0, ti.min(self.world.height - 1, sy))
                        out_img[x, y] = base_img[sx, sy]

        print("\n=== Bio-Grid Taichi Viewer ===")
        print("Controls:")
        print("  SPACE  - Pause/Resume")
        print("  1-5    - Switch view mode (eco/light/loss/mix/transfer)")
        print("  A      - Toggle aging glow")
        print("  +/-    - Adjust speed (TPS)")
        print("  R      - Reset world")
        print("  F      - Toggle FAST/STRICT (FAST RNG won't align with STRICT)")
        print("  ESC    - Exit")
        print()

        self.running = True
        self._last_sim_step_time = time.time()
        self._tick_acc = 0.0

        while self.running and window.running:
            # 处理输入
            self._handle_input(window)

            # --- Right sidebar (fixed layout) ---
            if self.ui_open:
                pad_x = 0.02
                right_x = sim_frac + pad_x
                right_w = sidebar_frac - pad_x * 1.2
                gui.begin("Controls", right_x, 0.02, right_w, 0.56)
                if gui.button("Pause/Run (SPACE)"):
                    self.paused = not self.paused
                if gui.button("Reset (R)"):
                    self._reset_world()
                gui.text(f"Mode: {'FAST' if self.fast_mode else 'STRICT'}")
                gui.text(f"View: {self.view_mode}")
                self.target_tps = int(gui.slider_int("Target TPS", int(self.target_tps), 1, 1920))
                self.show_aging_glow = bool(gui.checkbox("Aging glow (A)", bool(self.show_aging_glow)))
                gui.text("Brush: LMB drag (only inside left square viewport)")
                self.brush_radius = int(gui.slider_int("Radius", int(self.brush_radius), 1, 40))
                self.brush_gene = float(gui.slider_float("Gene", float(self.brush_gene), 0.0, 1.0))
                gui.text("Brush mode:")
                if gui.button("Seed"): self.brush_mode = 0
                if gui.button("Annihilate"): self.brush_mode = 1
                if gui.button("Wall"): self.brush_mode = 2
                if gui.button("Erase"): self.brush_mode = 3
                gui.text("View:")
                if gui.button("Eco (1)"): self.view_mode = "eco"
                if gui.button("Terrain Light (2)"): self.view_mode = "terrainLight"
                if gui.button("Terrain Loss (3)"): self.view_mode = "terrainLoss"
                if gui.button("Terrain Mix (4)"): self.view_mode = "terrainMix"
                if gui.button("Transfer (5)"): self.view_mode = "transfer"
                gui.end()

            # --- Mouse brush (LMB) ---
            if window.is_pressed(ti.ui.LMB):
                mx, my = window.get_cursor_pos()
                # cursor pos is normalized [0,1], y-up
                # Only respond inside the left square viewport (no stretching).
                px = int(mx * display_w) if display_w else -1
                py = int((1.0 - my) * display_h) if display_h else -1
                if (display_w is None) or (display_h is None):
                    cx = -1
                    cy = 0
                else:
                    sim_w = int(max(1, display_w * sim_frac))
                    sq = int(min(sim_w, display_h))
                    offx = int((sim_w - sq) // 2)
                    offy = int((display_h - sq) // 2)
                    if px >= sim_w:
                        cx = -1
                        cy = 0
                    elif (px < offx) or (px >= offx + sq) or (py < offy) or (py >= offy + sq):
                        cx = -1
                        cy = 0
                    else:
                        cx = int(((px - offx) * self.world.width) // max(1, sq))
                        cy = int(((py - offy) * self.world.height) // max(1, sq))
                        if cx < 0:
                            cx = 0
                        if cy < 0:
                            cy = 0
                        if cx >= self.world.width:
                            cx = self.world.width - 1
                        if cy >= self.world.height:
                            cy = self.world.height - 1
                if cx >= 0:
                    if isinstance(self.world, WorldTI):
                        _brush_circle_fast(
                            self.world.front.type, self.world.front.biomass, self.world.front.energy, self.world.front.gene, self.world.front.age,
                            self.world.back.type, self.world.back.biomass, self.world.back.energy, self.world.back.gene, self.world.back.age,
                            int(self.world.width),
                            int(cx), int(cy),
                            int(self.brush_radius),
                            int(self.brush_mode),
                            float(self.brush_gene),
                        )
                    else:
                        # strict: CPU set_cell loop
                        r = int(self.brush_radius)
                        for dy in range(-r, r + 1):
                            for dx in range(-r, r + 1):
                                if dx * dx + dy * dy > r * r:
                                    continue
                                x = cx + dx
                                y = cy + dy
                                if x < 0 or y < 0 or x >= self.world.width or y >= self.world.height:
                                    continue
                                if self.brush_mode == 0:
                                    self.world.set_cell(x, y, cell_type=CellType.PLANT, biomass=0.8, energy=30, gene=self.brush_gene, age=0)
                                elif self.brush_mode == 1:
                                    self.world.set_cell(x, y, cell_type=CellType.EMPTY, biomass=0, energy=0, gene=0, age=0)
                                elif self.brush_mode == 2:
                                    self.world.set_cell(x, y, cell_type=CellType.WALL, biomass=0, energy=0, gene=0, age=0)
                                else:
                                    self.world.set_cell(x, y, cell_type=CellType.EMPTY, biomass=0, energy=0, gene=0, age=0)

            # 更新模拟
            current_time = time.time()
            if not self.paused and self.target_tps > 0:
                if self.fast_mode and self.fast_ticker is not None:
                    # fast 模式：tick 很快，可以用 accumulator 追赶到目标 tps
                    dt = current_time - self._last_sim_step_time
                    if dt > 0:
                        self._tick_acc += dt * float(self.target_tps)
                    self._last_sim_step_time = current_time
                    ticks_this_frame = 0
                    max_ticks_per_frame = max(8, self.target_tps // 2)  # 防止极端 backlog 卡死
                    while self._tick_acc >= 1.0 and ticks_this_frame < max_ticks_per_frame:
                        tick_fast(self.world, self.fast_ticker)
                        self.tick_count += 1
                        self._tick_acc -= 1.0
                        ticks_this_frame += 1
                    if self._tick_acc > 4.0:
                        self._tick_acc = 4.0
                else:
                    # strict 模式：tick 很重，不追赶 backlog
                    step_interval = 1.0 / float(self.target_tps)
                    if current_time - self._last_sim_step_time >= step_interval:
                        tick(self.world, self.rng)
                        self.tick_count += 1
                        self._last_sim_step_time = current_time

            # 更新统计
            if current_time - self.last_stats_time >= 1.0:
                self.actual_tps = self.tick_count / (current_time - self.last_stats_time)
                self.tick_count = 0
                self.last_stats_time = current_time
            if current_time - self.last_fps_time >= 1.0:
                self.actual_fps = self.frame_count / (current_time - self.last_fps_time)
                self.frame_count = 0
                self.last_fps_time = current_time
            if current_time - self.last_stats_refresh_time >= self.stats_refresh_interval:
                if self.fast_mode and isinstance(self.world, WorldTI):
                    self.last_stats = get_stats_fast(self.world)
                else:
                    self.last_stats = compute_stats(self.world)
                self.last_stats_refresh_time = current_time
                # push history (normalized like web: biomass per cell)
                b = float(self.last_stats["total_biomass"]) / float(self.world.size)
                g = float(self.last_stats["avg_gene"])
                self.history_biomass.append(b)
                self.history_gene.append(g)
                if len(self.history_biomass) > self.history_max:
                    self.history_biomass = self.history_biomass[-self.history_max:]
                    self.history_gene = self.history_gene[-self.history_max:]

            # 渲染
            now_ms = time.time() * 1000
            self.renderer.render(
                self.world,
                view_mode=self.view_mode,
                show_aging_glow=self.show_aging_glow,
                now_ms=now_ms
            )

            # 显示
            # 为了避免“窗口缩放时糊成一片”，这里按窗口像素分辨率输出一张 display 图，并做最近邻采样。
            # 这样渲染效果更接近经典生命游戏：像素块清晰、拖动/缩放窗口不模糊。
            cur_w, cur_h = window.get_window_shape()
            cur_w = int(cur_w)
            cur_h = int(cur_h)
            if (display is None) or (display_w != cur_w) or (display_h != cur_h):
                display_w, display_h = cur_w, cur_h
                display = ti.Vector.field(3, dtype=ti.f32, shape=(display_w, display_h))
            sim_w = int(max(1, display_w * sim_frac))
            sq = int(min(sim_w, display_h))
            offx = int((sim_w - sq) // 2)
            offy = int((display_h - sq) // 2)
            _blit_to_display(self.renderer.img, display, display_w, display_h, sim_w, sq, offx, offy)
            canvas.set_image(display)

            # 显示状态信息
            if self.last_stats is None:
                stats = get_stats_fast(self.world) if self.fast_mode and isinstance(self.world, WorldTI) else compute_stats(self.world)
            else:
                stats = self.last_stats
            status = "PAUSED" if self.paused else f"{self.actual_tps:.1f} tps"
            try:
                gui.text(
                    f"Day {self.world.day:.2f} | Plants: {stats['plant_count']} | "
                    f"Biomass: {stats['total_biomass']:.1f} | Gene: {stats['avg_gene']:.3f} | "
                    f"{status} | {self.actual_fps:.0f} fps | {'FAST' if self.fast_mode else 'STRICT'}",
                    pos=(0.01, 0.98),
                    color=0xffffff
                )
            except Exception:
                # 某些 taichi 版本/后端下 gui.text 可能不可用；不影响主渲染
                pass

            # --- Simple charts (ImGui) ---
            try:
                pad_x = 0.02
                right_x = sim_frac + pad_x
                right_w = sidebar_frac - pad_x * 1.2
                gui.begin("Stats", right_x, 0.60, right_w, 0.30)
                if self.history_biomass:
                    gui.text(f"Biomass(avg): {self.history_biomass[-1]:.3f}")
                    gui.text(f"Avg Gene: {self.history_gene[-1]:.3f}")
                    # Taichi 1.7.x 没有 plot widget，这里用文本+最近值；后续可用 canvas.lines 画折线
                gui.end()
            except Exception:
                pass

            window.show()
            self.frame_count += 1

        window.destroy()

    def _handle_input(self, window: "ti.ui.Window"):
        """处理键盘输入"""
        while window.get_event(ti.ui.PRESS):
            e = window.event
            if e.key == ti.ui.ESCAPE:
                self.running = False
            elif e.key == ti.ui.SPACE:
                self.paused = not self.paused
                print("Paused" if self.paused else "Running")
            elif e.key == '1':
                self.view_mode = 'eco'
                print("View: eco")
            elif e.key == '2':
                self.view_mode = 'terrainLight'
                print("View: terrainLight")
            elif e.key == '3':
                self.view_mode = 'terrainLoss'
                print("View: terrainLoss")
            elif e.key == '4':
                self.view_mode = 'terrainMix'
                print("View: terrainMix")
            elif e.key == '5':
                self.view_mode = 'transfer'
                print("View: transfer")
            elif e.key == 'a':
                self.show_aging_glow = not self.show_aging_glow
                print(f"Aging glow: {'ON' if self.show_aging_glow else 'OFF'}")
            elif e.key in ('=', '+'):
                self.target_tps = min(1920, self.target_tps * 2)
                print(f"Target TPS: {self.target_tps}")
            elif e.key == '-':
                self.target_tps = max(1, self.target_tps // 2)
                print(f"Target TPS: {self.target_tps}")
            elif e.key == 'r':
                self._reset_world()
                print("World reset")
            elif e.key in ('f', 'F'):
                self.fast_mode = not self.fast_mode
                # strict 模式只支持 NumPy World；fast 模式只支持 WorldTI
                if self.fast_mode and not isinstance(self.world, WorldTI):
                    print("FAST mode needs WorldTI, restart run_viewer(fast=True)")
                    self.fast_mode = False
                if (not self.fast_mode) and isinstance(self.world, WorldTI):
                    print("STRICT mode needs NumPy World, restart run_viewer(fast=False)")
                    self.fast_mode = True
                if self.fast_mode:
                    self.target_tps = max(self.target_tps, 120)
                else:
                    self.target_tps = min(self.target_tps, 30)
                print(f"Mode: {'FAST' if self.fast_mode else 'STRICT'}")

    def _reset_world(self):
        """重置世界"""
        self.world.reset()
        self.rng = SFC32(12345)
        # 重新播种一些植物
        _seed_plants(self.world, count=self.world.size // 10)


def _seed_plants(world: World, count: int, seed: int = 42):
    """在世界中播种植物"""
    if isinstance(world, WorldTI):
        world.seed_plants(count=count, seed=seed)
        return
    rng = np.random.RandomState(seed)
    for _ in range(count):
        x = rng.randint(0, world.width)
        y = rng.randint(0, world.height)
        i = world.to_index(x, y)
        if world.front.type[i] == CellType.EMPTY:
            gene = rng.random()
            world.set_cell(
                x, y,
                cell_type=CellType.PLANT,
                biomass=0.5 + rng.random() * 0.5,
                energy=20 + rng.random() * 30,
                gene=gene,
                age=0
            )


def run_viewer(width: int = 64, height: int = 64, seed: int = 12345, window_scale: int = 8, fast: bool = True):
    """启动交互式查看器

    Args:
        width: 网格宽度
        height: 网格高度
        seed: 随机种子
        window_scale: 窗口缩放倍数
        fast: 是否使用 Taichi fast tick（阶段3，默认 True；目前不含繁殖）
    """
    # 初始化 Taichi
    ti.init(arch=ti.gpu, default_fp=ti.f32)

    # 创建世界（fast/strict）
    if fast:
        world = WorldTI(width, height)
        world.set_terrain_linear()
        _seed_plants(world, count=world.size // 8, seed=seed)
    else:
        world = World(width, height)
        for i in range(world.size):
            x, y = world.from_index(i)
            world.terrain.light[i] = 0.5 + (x / width) * 1.0
            world.terrain.loss[i] = 1.0 + (y / height) * 5.0
        world.terrain.recompute_ranges()
        _seed_plants(world, count=world.size // 8, seed=seed)

    # 运行应用
    app = BioGridApp(world, seed=seed, fast_mode=fast)
    app.run(window_scale=window_scale)


if __name__ == '__main__':
    run_viewer()
