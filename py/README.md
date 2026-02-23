# Bio-Grid Python + Taichi 实现

## 安装

```bash
cd py
pip install -e .
pip install taichi pillow  # Phase 2 渲染依赖
```

## 运行测试

```bash
# Python 内部测试
python3 tests/test_align.py

# JS/Python 对齐测试
python3 tests/test_js_alignment.py
```

## 模块结构

```
py/biogrid/
├── __init__.py       # 包入口
├── config.py         # 配置参数（与 src/config.js 对齐）
├── state.py          # 世界状态与数据布局
├── rng.py            # 可复现 RNG（SFC32）
├── tick.py           # Tick 逻辑（与 src/sim/tick.js 对齐）
├── render.py         # Taichi GPU 渲染器
├── viewer.py         # 交互式可视化窗口
└── export_render.py  # 渲染截图导出
```

## 快速开始

### 运行模拟

```python
from biogrid import World, tick, compute_stats, SFC32, CellType

# 创建世界
world = World(64, 64)

# 放置植物
world.set_cell(32, 32, cell_type=CellType.PLANT, biomass=0.8, energy=30, gene=0.5)

# 运行 tick
rng = SFC32(12345)
for _ in range(100):
    tick(world, rng)

# 获取统计
stats = compute_stats(world)
print(f"Plants: {stats['plant_count']}, Biomass: {stats['total_biomass']:.2f}")
```

## 两种运行模式：STRICT vs FAST（非常重要）

本项目目前同时维护两套 tick：

- **STRICT（严格对齐档）**：`biogrid.tick.tick(world, rng)`
  - **目标**：与 `src/sim/tick.js` 的规则与执行语义尽可能一致，用于回归与对齐测试（`tests/test_js_alignment.py`）。
  - **特点**：大量 Python/NumPy 计算 + 顺序繁殖，速度慢，但可作为“真值基准”。

- **FAST（性能档 / GPU）**：`biogrid.tick_fast_ti.tick_fast(world_ti, ticker)`
  - **目标**：在 Taichi/Metal 上高速运行，用于交互与大规模性能。
  - **特点**：并行 + atomic 累加，**不会保证与 JS/STRICT 的 tick-by-tick 随机序列完全一致**（尤其繁殖与邻居累加顺序）。
  - 规则条件保持一致，但输出可能存在细微差异；这是并行化的典型代价。

## 与前端联动：Taichi Dev Backend（/api/*）

仓库根目录的 `npm run dev:all` 会同时启动前端与本后端服务。前端通过同源的 `/api/*` 访问后端：

- `GET /api/health`：健康检查
- `POST /api/message`：控制消息（`init / setView / setTicksPerSecond / applyBrush / ...`）
- `GET /api/frame`：返回二进制帧（`u32 meta_len` + `meta(json)` + `RGBA(u8)`），用于前端直接贴图渲染

前端强制启用后端：

- `http://127.0.0.1:5173/?engine=taichi`

### 后端单独启动（调试）

```bash
cd py
python3 -m biogrid.dev_backend --port 8787
```

### 稳定性/回退

默认后端会优先使用 GPU（macOS 为 Metal）。如果 GPU 环境不稳定，可强制走 CPU：

```bash
BIOGRID_TAICHI_ARCH=cpu python3 -m biogrid.dev_backend --port 8787
```

（`/api/*` 在后端内部做了串行化保护，避免并发请求触发 Taichi runtime 崩溃。）

### 启动交互式查看器

```python
from biogrid import run_viewer
run_viewer(width=64, height=64, window_scale=8, fast=True)   # FAST：默认
run_viewer(width=64, height=64, window_scale=8, fast=False)  # STRICT：用于对齐/回归
```

或命令行：
```bash
python3 -c "from biogrid import run_viewer; run_viewer()"
```

### 查看器控制

查看器采用**左右两栏**布局：左侧为模拟画面（鼠标左键在左侧绘制/编辑），右侧为固定控制栏与数据摘要。

| 按键 | 功能 |
|------|------|
| SPACE | 暂停/继续 |
| 1-5 | 切换视图 (eco/light/loss/mix/transfer) |
| A | 切换衰老发光 |
| +/- | 调整速度 |
| R | 重置世界 |
| F | 切换 FAST/STRICT（需要对应 world 类型，切错会提示重启） |
| ESC | 退出 |

## 对齐测试

JS/Python 对齐验证流程：

```bash
# 1. JS 导出初始快照
node scripts/export_snapshot.mjs --width=32 --height=32 --seed=42 --output=initial.json

# 2. JS 运行 N tick 导出黄金结果
node scripts/run_ticks_and_export.mjs --input=initial.json --ticks=50 --seed=12345 --output=golden.json

# 3. Python 对齐测试
python3 tests/test_js_alignment.py
```
