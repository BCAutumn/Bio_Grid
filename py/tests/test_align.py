"""对齐测试框架 - 验证 Python 与 JS 实现的一致性"""

import json
import numpy as np
from pathlib import Path
from typing import Optional, Tuple
import sys
import os

# 添加父目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from biogrid import World, Config, tick, compute_stats, SFC32, CellType


def load_snapshot(path: str) -> dict:
    """加载 JS 导出的快照"""
    with open(path, 'r') as f:
        return json.load(f)


def save_snapshot(world: World, path: str):
    """保存快照"""
    with open(path, 'w') as f:
        json.dump(world.export_snapshot(), f, indent=2)


def compare_grids(py_world: World, js_snapshot: dict, tolerance: float = 1e-6) -> Tuple[bool, list]:
    """比较 Python 世界状态与 JS 快照

    Returns:
        (是否通过, 差异列表)
    """
    diffs = []
    js_front = js_snapshot.get('front', {})

    # 比较标量
    scalars = [
        ('time', py_world.time, js_snapshot.get('time', 0)),
        ('day', py_world.day, js_snapshot.get('day', 0)),
        ('sunlight', py_world.sunlight, js_snapshot.get('sunlight', 0)),
    ]

    for name, py_val, js_val in scalars:
        if abs(py_val - js_val) > tolerance:
            diffs.append(f"{name}: py={py_val:.10f}, js={js_val:.10f}, diff={abs(py_val - js_val):.2e}")

    # 比较数组
    arrays = [
        ('type', py_world.front.type, js_front.get('type', [])),
        ('biomass', py_world.front.biomass, js_front.get('biomass', [])),
        ('energy', py_world.front.energy, js_front.get('energy', [])),
        ('gene', py_world.front.gene, js_front.get('gene', [])),
        ('age', py_world.front.age, js_front.get('age', [])),
    ]

    for name, py_arr, js_arr in arrays:
        if len(js_arr) == 0:
            continue
        js_np = np.array(js_arr, dtype=py_arr.dtype)

        if name == 'type':
            # 类型必须完全一致
            mismatches = np.where(py_arr != js_np)[0]
            if len(mismatches) > 0:
                for idx in mismatches[:5]:  # 只显示前5个
                    diffs.append(f"{name}[{idx}]: py={py_arr[idx]}, js={js_np[idx]}")
                if len(mismatches) > 5:
                    diffs.append(f"  ... and {len(mismatches) - 5} more {name} mismatches")
        else:
            # 浮点数允许容差
            diff_arr = np.abs(py_arr - js_np)
            max_diff = np.max(diff_arr)
            if max_diff > tolerance:
                worst_idx = np.argmax(diff_arr)
                diffs.append(f"{name}: max_diff={max_diff:.2e} at [{worst_idx}] (py={py_arr[worst_idx]:.10f}, js={js_np[worst_idx]:.10f})")

                # 统计超出容差的数量
                over_tolerance = np.sum(diff_arr > tolerance)
                if over_tolerance > 1:
                    diffs.append(f"  {over_tolerance} cells exceed tolerance")

    return len(diffs) == 0, diffs


def run_alignment_test(
    initial_snapshot: dict,
    golden_snapshot: dict,
    n_ticks: int,
    seed: int = 12345,
    tolerance: float = 1e-6,
    verbose: bool = True
) -> Tuple[bool, list]:
    """运行对齐测试

    Args:
        initial_snapshot: 初始状态快照
        golden_snapshot: JS 运行 n_ticks 后的"黄金"结果
        n_ticks: 要运行的 tick 数
        seed: RNG 种子
        tolerance: 浮点容差
        verbose: 是否打印详细信息

    Returns:
        (是否通过, 差异列表)
    """
    # 从快照恢复世界
    world = World.from_snapshot(initial_snapshot)
    rng = SFC32(seed)

    if verbose:
        print(f"Running {n_ticks} ticks with seed={seed}...")
        print(f"Initial: {world.width}x{world.height}, plants={np.sum(world.front.type == CellType.PLANT)}")

    # 运行 tick
    for t in range(n_ticks):
        tick(world, rng)
        if verbose and (t + 1) % 10 == 0:
            stats = compute_stats(world)
            print(f"  Tick {t + 1}: plants={stats['plant_count']}, biomass={stats['total_biomass']:.2f}")

    # 比较结果
    passed, diffs = compare_grids(world, golden_snapshot, tolerance)

    if verbose:
        if passed:
            print(f"✓ Alignment test PASSED (tolerance={tolerance})")
        else:
            print(f"✗ Alignment test FAILED with {len(diffs)} differences:")
            for d in diffs[:20]:
                print(f"  {d}")
            if len(diffs) > 20:
                print(f"  ... and {len(diffs) - 20} more")

    return passed, diffs


def create_test_world(width: int = 32, height: int = 32, seed: int = 42) -> World:
    """创建测试用世界（带一些初始植物）"""
    world = World(width, height)
    rng = np.random.RandomState(seed)

    # 随机放置一些植物
    n_plants = width * height // 10
    for _ in range(n_plants):
        x = rng.randint(0, width)
        y = rng.randint(0, height)
        gene = rng.random()
        world.set_cell(
            x, y,
            cell_type=CellType.PLANT,
            biomass=0.5 + rng.random() * 0.5,
            energy=20 + rng.random() * 30,
            gene=gene,
            age=0
        )

    # 设置一些地形变化
    for i in range(world.size):
        x, y = world.from_index(i)
        # 简单的梯度地形
        world.terrain.light[i] = 0.5 + (x / width)
        world.terrain.loss[i] = 1.0 + (y / height) * 5

    world.terrain.recompute_ranges()
    return world


def test_basic_tick():
    """基础 tick 测试（不依赖 JS 快照）"""
    print("\n=== Basic Tick Test ===")
    world = create_test_world(32, 32)
    rng = SFC32(12345)

    initial_plants = np.sum(world.front.type == CellType.PLANT)
    print(f"Initial plants: {initial_plants}")

    # 运行 10 个 tick
    for t in range(10):
        tick(world, rng)

    stats = compute_stats(world)
    print(f"After 10 ticks:")
    print(f"  Plants: {stats['plant_count']}")
    print(f"  Total biomass: {stats['total_biomass']:.4f}")
    print(f"  Avg gene: {stats['avg_gene']:.4f}")
    print(f"  Time: {world.time:.4f}, Day: {world.day:.4f}")

    # 基本健全性检查
    assert stats['plant_count'] >= 0, "Plant count should be non-negative"
    assert stats['total_biomass'] >= 0, "Total biomass should be non-negative"
    assert 0 <= stats['avg_gene'] <= 1 or stats['plant_count'] == 0, "Avg gene should be in [0,1]"

    print("✓ Basic tick test passed")


def test_rng_determinism():
    """测试 RNG 确定性"""
    print("\n=== RNG Determinism Test ===")

    # 两个相同种子的 RNG 应该产生相同序列
    rng1 = SFC32(12345)
    rng2 = SFC32(12345)

    for i in range(100):
        v1 = rng1()
        v2 = rng2()
        assert v1 == v2, f"RNG mismatch at {i}: {v1} != {v2}"

    print("✓ RNG determinism test passed")


def test_world_snapshot_roundtrip():
    """测试快照导出/导入"""
    print("\n=== Snapshot Roundtrip Test ===")

    world1 = create_test_world(16, 16)
    snapshot = world1.export_snapshot()
    world2 = World.from_snapshot(snapshot)

    # 比较
    assert world1.width == world2.width
    assert world1.height == world2.height
    assert np.allclose(world1.time, world2.time)
    assert np.array_equal(world1.front.type, world2.front.type)
    assert np.allclose(world1.front.energy, world2.front.energy)
    assert np.allclose(world1.front.biomass, world2.front.biomass)
    assert np.allclose(world1.front.gene, world2.front.gene)
    assert np.allclose(world1.terrain.light, world2.terrain.light)
    assert np.allclose(world1.terrain.loss, world2.terrain.loss)

    print("✓ Snapshot roundtrip test passed")


def test_tick_determinism():
    """测试 tick 确定性（相同输入 -> 相同输出）"""
    print("\n=== Tick Determinism Test ===")

    # 创建两个相同的世界
    world1 = create_test_world(24, 24, seed=42)
    world2 = World.from_snapshot(world1.export_snapshot())

    rng1 = SFC32(99999)
    rng2 = SFC32(99999)

    # 运行相同数量的 tick
    for _ in range(20):
        tick(world1, rng1)
        tick(world2, rng2)

    # 比较结果
    assert np.array_equal(world1.front.type, world2.front.type), "Type mismatch"
    assert np.allclose(world1.front.energy, world2.front.energy), "Energy mismatch"
    assert np.allclose(world1.front.biomass, world2.front.biomass), "Biomass mismatch"
    assert np.allclose(world1.front.gene, world2.front.gene), "Gene mismatch"
    assert np.allclose(world1.front.age, world2.front.age), "Age mismatch"

    print("✓ Tick determinism test passed")


def test_no_reproduction():
    """测试关闭繁殖的对齐（层 1）"""
    print("\n=== No Reproduction Test ===")

    # 创建一个没有繁殖条件的世界（所有植物 biomass 低于繁殖阈值）
    world = World(16, 16)
    for i in range(world.size):
        if i % 5 == 0:
            world.front.type[i] = CellType.PLANT
            world.front.biomass[i] = 0.3  # 低于 reproBiomassRatio * maxBiomass
            world.front.energy[i] = 10
            world.front.gene[i] = 0.5
            world.back.type[i] = CellType.PLANT
            world.back.biomass[i] = 0.3
            world.back.energy[i] = 10
            world.back.gene[i] = 0.5

    rng = SFC32(11111)
    initial_plants = np.sum(world.front.type == CellType.PLANT)

    # 运行几个 tick
    for _ in range(5):
        tick(world, rng)

    final_plants = np.sum(world.front.type == CellType.PLANT)
    print(f"Plants: {initial_plants} -> {final_plants}")

    # 由于 biomass 低，不应该有繁殖发生（植物数只能减少或不变）
    assert final_plants <= initial_plants, "No reproduction should occur with low biomass"

    print("✓ No reproduction test passed")


def run_all_tests():
    """运行所有测试"""
    print("=" * 60)
    print("Bio-Grid Python Implementation Tests")
    print("=" * 60)

    test_rng_determinism()
    test_world_snapshot_roundtrip()
    test_basic_tick()
    test_tick_determinism()
    test_no_reproduction()

    print("\n" + "=" * 60)
    print("All tests passed!")
    print("=" * 60)


if __name__ == '__main__':
    run_all_tests()
