import time
import taichi as ti

from biogrid.world_ti import WorldTI
from biogrid.tick_fast_ti import FastTicker, tick_fast
from biogrid.render import TaichiRenderer


def bench(w: int = 256, h: int = 256, ticks: int = 500, renders: int = 500):
    ti.init(arch=ti.gpu, default_fp=ti.f32)
    world = WorldTI(w, h)
    world.set_terrain_linear()
    world.seed_plants(count=world.size // 8, seed=42)
    ticker = FastTicker(w, h)
    renderer = TaichiRenderer(w, h)

    for _ in range(20):
        tick_fast(world, ticker)
    renderer.render(world, view_mode="eco", show_aging_glow=False, now_ms=0)
    ti.sync()

    st = time.perf_counter()
    for _ in range(ticks):
        tick_fast(world, ticker)
    ti.sync()
    mid = time.perf_counter()

    for _ in range(renders):
        renderer.render(world, view_mode="eco", show_aging_glow=False, now_ms=0)
    ti.sync()
    end = time.perf_counter()

    print(f"grid={w}x{h}")
    print(f"fast_tick_ms_per={(mid - st) * 1000 / ticks:.4f}")
    print(f"render_ms_per={(end - mid) * 1000 / renders:.4f}")


if __name__ == '__main__':
    bench()

