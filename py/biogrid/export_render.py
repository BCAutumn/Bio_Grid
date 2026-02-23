"""渲染截图导出工具 - 用于 JS/Python 渲染对齐验证"""

import numpy as np
from pathlib import Path
from PIL import Image
import json

import taichi as ti

from biogrid import World, CellType, tick, SFC32
from biogrid.render import TaichiRenderer


def export_render_screenshot(world: World, output_path: str, view_mode: str = 'eco',
                             show_aging_glow: bool = False, now_ms: float = 0.0):
    """导出渲染截图为 PNG

    Args:
        world: 世界状态
        output_path: 输出文件路径
        view_mode: 视图模式
        show_aging_glow: 是否显示衰老发光
        now_ms: 当前时间（毫秒）
    """
    renderer = TaichiRenderer(world.width, world.height)
    renderer.render(world, view_mode=view_mode, show_aging_glow=show_aging_glow, now_ms=now_ms)

    # 获取图像并转换为 uint8
    img = renderer.get_image()
    img_uint8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)

    # 翻转 Y 轴（Taichi 的 Y 轴是从下往上）
    # 注意：render.py 中已经做了翻转，这里不需要再翻转

    # 保存为 PNG
    Image.fromarray(img_uint8).save(output_path)
    print(f"Saved: {output_path}")


def export_all_views(world: World, output_dir: str, prefix: str = 'render'):
    """导出所有视图模式的截图

    Args:
        world: 世界状态
        output_dir: 输出目录
        prefix: 文件名前缀
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    views = ['eco', 'terrainLight', 'terrainLoss', 'terrainMix']
    for view in views:
        export_render_screenshot(
            world,
            str(output_path / f"{prefix}_{view}.png"),
            view_mode=view
        )

    # 导出带衰老发光的 eco 视图
    export_render_screenshot(
        world,
        str(output_path / f"{prefix}_eco_aging.png"),
        view_mode='eco',
        show_aging_glow=True
    )


def create_test_world(width: int = 64, height: int = 64, seed: int = 42) -> World:
    """创建测试用世界"""
    world = World(width, height)
    rng = np.random.RandomState(seed)

    # 设置地形
    for i in range(world.size):
        x, y = world.from_index(i)
        world.terrain.light[i] = 0.5 + (x / width) * 1.0
        world.terrain.loss[i] = 1.0 + (y / height) * 5.0
    world.terrain.recompute_ranges()

    # 放置植物
    n_plants = world.size // 8
    for _ in range(n_plants):
        x, y = rng.randint(0, width), rng.randint(0, height)
        i = world.to_index(x, y)
        if world.front.type[i] == CellType.EMPTY:
            gene = rng.random()
            age = rng.random() * 3  # 随机年龄，用于测试衰老发光
            world.set_cell(
                x, y,
                cell_type=CellType.PLANT,
                biomass=0.5 + rng.random() * 0.5,
                energy=20 + rng.random() * 30,
                gene=gene,
                age=age
            )

    return world


def main():
    """生成测试截图"""
    import sys

    # 初始化 Taichi
    ti.init(arch=ti.cpu)

    # 创建测试世界
    print("Creating test world...")
    world = create_test_world(64, 64, seed=42)

    # 运行几个 tick 让世界演化
    print("Running 20 ticks...")
    rng = SFC32(12345)
    for _ in range(20):
        tick(world, rng)

    # 导出截图
    output_dir = Path(__file__).parent.parent / 'tests' / 'render_screenshots'
    print(f"\nExporting screenshots to {output_dir}...")
    export_all_views(world, str(output_dir), prefix='py')

    print("\nDone! Compare these with JS renders for visual alignment verification.")


if __name__ == '__main__':
    main()
