# Bio-Grid

一个基于浮点状态与能量守恒的极简生命模拟器。目标是模拟生成可自愈、可进化、可扩展的生态行为。

## 快速开始

```bash
npm run dev:all
```

默认地址：`http://127.0.0.1:5173`

### 推荐：Taichi 后端引擎（大规模 / 更稳定吞吐）

`dev:all` 会同时启动：

- 前端静态服务器（带 COOP/COEP 头，便于 SharedArrayBuffer）
- Python + Taichi 后端（用于 fast tick + 后端渲染）

打开：

- `http://127.0.0.1:5173/?engine=taichi` 强制使用 Taichi 后端
- `http://127.0.0.1:5173/?engine=js` 强制使用旧 JS Worker 内核
- `http://127.0.0.1:5173/` 默认 `engine=auto`：能探测到后端就用 Taichi，否则回退 JS Worker

成功连上后端后，控制台会打印 `"[backend] ready"`，页面标题处也会显示 `Engine: taichi`。

### 仅前端（不启动 Python 后端）

```bash
npm run dev
```

运行测试：

```bash
npm test
```

## 已实现能力

- 双缓冲主循环（读 `front`，写 `back`）。
- 昼夜光照：`Sunlight = max(0, sin(Time * Speed))`。
- 地形异质性：内置固定地形图 `terrain.light / terrain.loss`（不新增调参）；地形直接影响 `sunlight` 强度与 `baseCost` 代谢开销。
- 能量扩散：梯度驱动扩散 + 按能量缺口加权分配（源-汇动力学），详见 `docs/RULES.md`。
- 植物代谢：光合作用收入 + 基础代谢支出。
- 生长/凋亡：能量正负决定生物量增减。
- 密度惩罚：局部过密增加能量消耗，或者缺乏邻居（小于2个）时触发“孤独”能量流失。
- 繁殖 + 基因突变：成熟且高能量，且周围有同样符合条件的“伴侣”时，共同消耗能量向空地扩散。
- 墙体：不参与扩散并阻断邻居扩散计算。
- 交互面板与笔刷模式：提供生命之笔、扰动、毁灭、墙体多种笔刷模式，支持左键拖动绘制。
- 顶部多标签工作流：宽屏为「控制台 / 地图编辑器」，窄屏增加「数据与图表」标签。
- 地图编辑器：集中提供地形视图、墙体/擦除笔刷、形状切换、地形预设与撤销/重做。
- 视图切换：支持生态视图 / 地形光照视图 / 地形流失视图 / 复合地形视图（更易观察地形组合）。
- 可缩放观察：滚轮缩放 + 空格拖动画布平移。
- 速度范围扩展：`0.2 ~ 480 tick/s`，可做超慢速微观观察。
- Worker + SharedArrayBuffer 快照通道：模拟与渲染线程分离，减少高速下主线程卡顿。
- OffscreenCanvas Worker 渲染：在支持环境下把主画布像素着色迁移到 Worker，进一步降低主线程负载。
- 实时数据面板：总生物量与平均基因曲线。

## 项目结构

```txt
Bio_Grid/
  index.html
  package.json
  scripts/dev-server.mjs
  scripts/dev-all.mjs
  src/
    sim/
      brush.js
      index.js
      presets.js
      shared.js
      world.js
      tick.js
    main.js
    main-dom.js
    main-interactions.js
    main-tabs.js
    main-shared-channels.js
    render.js            # 主线程渲染
    workers/
      sim-worker/
        index.js
        render.js            # OffscreenCanvas 渲染
        snapshots.js
        terrain.js
        history.js
    styles.css
    config.js
  py/
    README.md
    biogrid/
      dev_backend.py        # Taichi 后端（/api/*）
  tests/
    sim-core.test.js
  docs/
    PLAYBOOK.md
```

## 开发规范

### 1. 核心规则最小化

- 核心模拟拆分在 `src/sim/`（`tick.js/world.js/brush.js/presets.js`），对外统一从 `src/sim/index.js` 导出。
- 核心逻辑优先保证规则清晰、可测试、可优化。
- 新增玩法优先通过 `extensions.typeUpdaters` 或配置扩展，不直接破坏主循环。
- 目标是用最少的参数和变量实现尽可能多的规则，不要添加看起来有用实际上影响不大的参数和变量。
- 基因相关公式优先使用简单易懂的加法或减法。

### 2. 高内聚低耦合

- 模拟与渲染解耦：
  - `src/sim/` 只负责状态更新。
  - `render.js` 只负责可视化映射。
  - `main.js` 只做主线程编排（Worker 通信、相机、帧循环）。
  - `main-dom.js` 只负责 DOM 引用收集；`main-tabs.js` 只负责侧栏 Tab 切换。
  - `src/workers/sim-worker/index.js` 只做消息分发与调度；具体职责拆分为：
    - `src/workers/sim-worker/render.js`（Worker 渲染）
    - `src/workers/sim-worker/snapshots.js`（快照/共享内存发布）
    - `src/workers/sim-worker/terrain.js`（地形笔刷）
    - `src/workers/sim-worker/history.js`（地形撤销/重做历史）
- 禁止在核心模拟层访问 DOM。

### 3. 边界与健壮性

- 所有基因、生物量都做 `clamp(0..1)`。
- 越界坐标直接忽略，不抛异常。
- 双缓冲避免“同帧读写污染”。
- 墙体能量固定为 0，且不进入扩散平均。
- 密度凋亡：采用局部条件：8 邻域植物数超过阈值触发能量流失。

### 4. 扩展原则

- `Type=2`（捕食者）预留于 `world.extensions.typeUpdaters[2]`。
- 新类型必须补测试，至少包含：
  - 与扩散交互。
  - 与死亡/繁殖边界交互。
  - 规则极值（零能量、极端基因、边缘坐标）。

### 5. 测试规范

- 使用 Node 内建 `node:test`，保证零外部依赖。
- 每次修改核心逻辑后必须执行 `npm test`。
- 当前测试覆盖：
  - 扩散平滑。
  - 墙体阻断。
  - 生死判定。
  - 繁殖突变。
  - 密度衰亡测试（耗尽能量后才凋亡）。

### 6. 性能规范

- 网格数据使用 TypedArray。
- 采用“Tick 累加器”调度，支持低于 1 tick/s 的慢速仿真。
- 渲染采用 `ImageData` 批量写像素，避免逐格 `fillRect`。
- 邻域访问采用预计算索引缓存，减少 Tick 热路径中的边界判断与索引换算。
- `tick()` 热路径可做内联与局部变量缓存优化，但不修改任何生态规则参数。

### 7. 行为等价性声明（性能优化）

- 性能优化只改变执行路径，不改变规则本身：不改阈值、不改公式、不改状态机。
- 邻居索引缓存只保存拓扑关系（每个格子的邻接索引），不包含随机数，不会“预先设定随机行为”。
- 随机行为仍在 `tick()` 运行时通过 `rng()` 即时生成；没有预采样随机表、没有固定脚本化随机序列。
- 在相同初始状态与相同 RNG 序列下，优化前后应保持相同规则语义与可复现实验趋势。

## 交互速览

- 左键拖动：根据当前选择的笔刷模式在画布上绘制（播种、干扰、毁灭、墙体）。
- 预设地图：提供空地、四宫格、迷宫、五区地形、沙漏、同心环、纵向梯度等快捷地形，并支持撤销/重做恢复编辑。
- 滚轮：缩放。
- 空格 + 拖动：平移视角。

详细玩法见：`docs/PLAYBOOK.md`。

## 已知限制

- 若不通过带 COOP/COEP 头的服务运行，浏览器会禁用 SharedArrayBuffer 并自动回退普通快照模式。
- Taichi 后端为开发期集成，异常时可用 `?engine=js` 立即回退旧 JS Worker 内核，保证前端可用性。
- 若 GPU/Metal 环境不稳定，可用环境变量强制后端走 CPU：`BIOGRID_TAICHI_ARCH=cpu npm run dev:all`。

## 未来开发方向（分阶段）

### 阶段 A：先把规则调教稳定（当前优先）

- 以小到中等规模网格为主（当前默认 `240 x 240`），优先验证生态行为是否合理。
- 重点打磨：昼夜代谢、拥挤/孤独惩罚、双亲繁殖、边界效应与参数稳定区间。
- 在不增加复杂新机制的前提下，持续优化规则可解释性与可复现实验结果。

### 阶段 B：规则成熟后再推进超大规模

- 在现有 Web 架构继续做性能路线：`Worker + SharedArrayBuffer` -> `OffscreenCanvas` -> `WebGPU/WASM`。
- 评估并行原型（如 Taichi/Python）作为超大规模计算内核，用于离线基准与大规模实验。
- 目标是在规则收敛后再扩展到更大网格，而不是在规则未稳定时盲目追求规模。

### Python + Taichi 原型（现已落地）

- `py/` 目录提供 Python 实现与 Taichi 加速路径。
- **STRICT 模式**：用于与 Web(JS) 规则对齐与回归（见 `py/tests/test_js_alignment.py`）。
- **FAST 模式**：用于高性能交互与大规模吞吐（GPU 并行，随机序列与累加顺序不保证逐 tick 与 JS 完全一致）。

### 架构迁移路线（当前执行中）

- 当前仓库同时保留：
  - 旧 JS 内核（`src/sim/*` + `src/workers/sim-worker/*`）：用于对齐、回归与紧急回退。
  - Taichi 后端内核（`py/biogrid/*` + `/api/*`）：用于大规模性能与稳定吞吐。
- 目标：在 **完全对齐旧 JS 规则** 后，逐步移除旧 JS 核心实现，仅保留前端交互/渲染与后端 Taichi 高性能计算作为唯一内核。
