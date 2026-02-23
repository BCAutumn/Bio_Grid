"""JS/Python 对齐测试 - 使用 JS 导出的快照验证"""

import json
import numpy as np
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from biogrid import World, Config, tick, compute_stats, SFC32, CellType


def load_snapshot(path: str) -> dict:
    with open(path, 'r') as f:
        return json.load(f)


def compare_arrays(name: str, py_arr: np.ndarray, js_arr: list, tolerance: float = 1e-6) -> list:
    """比较数组，返回差异列表"""
    diffs = []
    js_np = np.array(js_arr, dtype=py_arr.dtype)

    if name == 'type':
        mismatches = np.where(py_arr != js_np)[0]
        if len(mismatches) > 0:
            for idx in mismatches[:5]:
                diffs.append(f"{name}[{idx}]: py={py_arr[idx]}, js={js_np[idx]}")
            if len(mismatches) > 5:
                diffs.append(f"  ... and {len(mismatches) - 5} more {name} mismatches")
    else:
        diff_arr = np.abs(py_arr.astype(np.float64) - js_np.astype(np.float64))
        max_diff = np.max(diff_arr)
        if max_diff > tolerance:
            worst_idx = np.argmax(diff_arr)
            diffs.append(f"{name}: max_diff={max_diff:.2e} at [{worst_idx}] (py={py_arr[worst_idx]:.10f}, js={js_np[worst_idx]:.10f})")
            over_tolerance = np.sum(diff_arr > tolerance)
            if over_tolerance > 1:
                diffs.append(f"  {over_tolerance} cells exceed tolerance")

    return diffs


def run_js_alignment_test(initial_path: str, golden_path: str, n_ticks: int, seed: int = 12345, tolerance: float = 1e-6):
    """运行 JS/Python 对齐测试"""
    print(f"\n{'='*60}")
    print(f"JS/Python Alignment Test")
    print(f"{'='*60}")
    print(f"Initial: {initial_path}")
    print(f"Golden:  {golden_path}")
    print(f"Ticks:   {n_ticks}, Seed: {seed}, Tolerance: {tolerance}")
    print()

    # 加载快照
    initial = load_snapshot(initial_path)
    golden = load_snapshot(golden_path)

    # 从快照恢复世界
    world = World.from_snapshot(initial)
    rng = SFC32(seed)

    initial_plants = np.sum(world.front.type == CellType.PLANT)
    print(f"Initial plants: {initial_plants}")

    # 运行 tick
    for t in range(n_ticks):
        tick(world, rng)
        if (t + 1) % 10 == 0 or t == n_ticks - 1:
            stats = compute_stats(world)
            print(f"  Tick {t + 1}: plants={stats['plant_count']}, biomass={stats['total_biomass']:.2f}")

    # 比较结果
    all_diffs = []

    # 比较标量
    scalars = [
        ('time', world.time, golden.get('time', 0)),
        ('day', world.day, golden.get('day', 0)),
        ('sunlight', world.sunlight, golden.get('sunlight', 0)),
    ]
    for name, py_val, js_val in scalars:
        if abs(py_val - js_val) > tolerance:
            all_diffs.append(f"{name}: py={py_val:.10f}, js={js_val:.10f}, diff={abs(py_val - js_val):.2e}")

    # 比较数组
    js_front = golden.get('front', {})
    arrays = [
        ('type', world.front.type, js_front.get('type', [])),
        ('biomass', world.front.biomass, js_front.get('biomass', [])),
        ('energy', world.front.energy, js_front.get('energy', [])),
        ('gene', world.front.gene, js_front.get('gene', [])),
        ('age', world.front.age, js_front.get('age', [])),
    ]
    for name, py_arr, js_arr in arrays:
        if len(js_arr) > 0:
            all_diffs.extend(compare_arrays(name, py_arr, js_arr, tolerance))

    # 输出结果
    print()
    if len(all_diffs) == 0:
        print(f"✓ PASSED - All values match within tolerance {tolerance}")
        return True
    else:
        print(f"✗ FAILED - {len(all_diffs)} differences found:")
        for d in all_diffs[:30]:
            print(f"  {d}")
        if len(all_diffs) > 30:
            print(f"  ... and {len(all_diffs) - 30} more")
        return False


def main():
    fixtures_dir = Path(__file__).parent / 'fixtures'
    all_passed = True

    # 测试 10 tick 对齐
    passed = run_js_alignment_test(
        initial_path=str(fixtures_dir / 'initial_24x24.json'),
        golden_path=str(fixtures_dir / 'golden_24x24_t10.json'),
        n_ticks=10,
        seed=12345,
        tolerance=1e-5
    )
    all_passed = all_passed and passed

    # 测试 50 tick 对齐
    passed = run_js_alignment_test(
        initial_path=str(fixtures_dir / 'initial_24x24.json'),
        golden_path=str(fixtures_dir / 'golden_24x24_t50.json'),
        n_ticks=50,
        seed=12345,
        tolerance=1e-4  # 50 tick 累积误差稍大，但仍在可接受范围
    )
    all_passed = all_passed and passed

    print()
    if all_passed:
        print("=" * 60)
        print("All JS/Python alignment tests PASSED!")
        print("=" * 60)
    else:
        print("=" * 60)
        print("Some tests FAILED - check differences above")
        print("=" * 60)
        sys.exit(1)


if __name__ == '__main__':
    main()
