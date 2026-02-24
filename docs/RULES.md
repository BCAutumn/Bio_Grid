# Bio-Grid 规则设定详解

Bio-Grid 是一个基于网格的生态热力学模拟器，主要使用能量（Energy）与生物量（Biomass）两项数值来衡量生命的兴衰。这里详细说明了每一个网格（细胞）的生存、繁衍与死亡规则。

## 1. 核心属性与基础参数

每个格子（细胞）包含以下状态：
- **Type**：类型（0 = 空地，1 = 植物，3 = 墙体）。
- **Biomass**：生物量。上限由基因决定（见下文），当生物量归零时，细胞彻底死亡变为空地。
- **Energy**：能量储备。上限由基因决定（见下文），维持生命、抵抗密度压力、繁衍后代均需要消耗能量。
- **Gene**：基因值（0 到 1 之间）。影响细胞的光合作用效率、基础代谢率、体型（能量/生物量上限）、寿命以及视觉颜色。
- **Age**：年龄（天数）。植物细胞每 Tick 增加 `ΔDay = timeStep × sunSpeed / 2π`，用于寿命与衰老判定。
- **TerrainLight**：地形光照系数（固定环境层）。该值直接乘到全局 `Sunlight` 上，决定该格子的有效光照强度。
- **TerrainLoss**：地形流失系数（固定环境层）。该值只作用于 `baseCost` 基项，决定该格子的环境维持成本。

### 基因与体型（胖/瘦）
基因同时控制代谢策略与体型，二者正相关：保守型偏胖，激进型偏瘦。
- **能量上限**：`maxEnergy = 72 - Gene × 36`
  - 保守型（Gene=0）：72
  - 激进型（Gene=1）：36
- **生物量上限**：`maxBiomass = 1.8 - Gene × 0.8`
  - 保守型（Gene=0）：1.8
  - 激进型（Gene=1）：1.0

### 寿命与衰老
- **Age**：每个植物细胞每 Tick 年龄增加 `ΔDay`（见上文），新生细胞（播种、繁殖）年龄为 0。
- **最大寿命**：`maxAge = 3 + (1 - Gene) × 2.5`（天数）
  - 保守型（Gene=0）：5.5 天
  - 激进型（Gene=1）：3 天
- **衰老期**：当植物度过了一生 70% 的时间（即 `age > maxAge × 0.7`）后，就会进入衰老期。
  - 衰老会导致生命维持成本上升。额外的代谢负担会随年龄**线性加重**，临近老死时，基础代谢会平滑攀升到年轻时的 **4 倍**。
  - **公式表示**：`Cost = Cost0 + Cost0 × 3 × t`
    - `Cost0` 为年轻时的正常代谢（详见第 2 节）。
    - `t` 为衰老进度，范围从 0（刚开始衰老）到 1（即将老死）：`t = max(0, (age - 0.7 × maxAge) / (0.3 × maxAge))`
- **老死**：当 `age >= maxAge` 时，细胞强制死亡（变为空地），能量与生物量清零。

### 全局循环参数与时间尺度（重要）
- **Tick 与 Time 的关系**：每 1 个 Tick，内部时间 `Time` 增加 `timeStep`（默认 0.05）。
- **模拟 Tick 速度（UI）**：`0.2 ~ 1920 tick/s`（仅改变模拟推进快慢，不改变单 Tick 生态规则）。
- **天数（Day）**：`Day = Time × sunSpeed / 2π`，即相位归一化后的完整周期数。UI 面板显示此值。
- **昼夜更替**：光照 `Sunlight = max(0, sin(Time × sunSpeed))`，`sunSpeed` 默认 0.014。
- **昼夜速度可调范围（UI）**：`0.004 ~ 0.12`（越大昼夜更替越快，夜晚压力越强）。
- **Sunlight**：当前全局光照（0 到 1，随昼夜周期波动 `max(0, sin(Time × sunSpeed))`）。
  - **尺度说明**：Energy 是模型内部数值标尺，不直接等同真实生态学单位。UI 中建议以归一化值（`Energy / maxEnergy`）观察状态变化，其中 maxEnergy 取保守型上限 72 作为显示标尺。

### 地形环境层（固定，不随 Tick 变化）
- 世界初始化时会生成两张与网格同尺寸的地形图：
  - `TerrainLight`：范围为 `[0, 2]`，表示局部光照放大/衰减（1光照为正常地区的正午光照强度，2光照为正常地区的正午光照强度的2倍，一般不会出现，这里仅为参数上限，标准地形为[0, 1]）。
  - `TerrainLoss`：默认噪声地形范围约为 `1 ~ 13`，范围为 `[1, 25]`，表示局部代谢流失强度（下限 1 表示维持生命活动的基础流失）。
- 两个系数彼此独立，因此地图上会自然出现“高光照高流失”“高光照低流失”“低光照高流失”“低光照低流失”等组合地形。

## 2. 能量摄入与消耗（代谢）

每过 1 个 Tick，每个植物细胞都要计算其能量的收入与支出：

1. **光合作用收入（Income）**
   收入与当前的阳光强度和细胞自身的基因相关。高基因（激进）的细胞光合作用效率远超低基因（保守）细胞。
   - `LocalSunlight = Sunlight × TerrainLight`
   - `Income = LocalSunlight * (0.02 + Gene * 0.03)`

2. **基础代谢支出（Cost）**
   维持生命的基础开销，基因越激进，代谢支出越高（呈平方级增长）。
   - 参数化写法：`Cost0 = baseCost × TerrainLoss + Gene² × geneCostFactor`
   - 默认参数：`baseCost = 0.0006`，`geneCostFactor = 0.002`，所以等价于 `Cost0 = 0.0006 × TerrainLoss + Gene² × 0.002`

3. **能量扩散（Diffusion）**

   能量扩散是“局部再分配”，发生在每个 Tick 的最开始。当前扩散由两部分“梯度项” + 一条“溢出输血”规则组成：

   1. **物理扩散（绝对能量梯度）**：
      - **扩散源**：自身是活体植物且 `Energy > 0`。
      - **扩散对象**：只对 8 邻域内的**活体植物**扩散（严格定义：`Type = PLANT` 且 `Biomass > 0`）。空地/墙体不接收，也不参与平均值计算。
      - **启动条件**：`Energy_self - Avg(Energy_neighbors) > diffuseGradientThreshold`
      - **外流上限**：`Energy_self × outFrac`，其中 `outFrac = diffuseNeighbor/(diffuseSelf+diffuseNeighbor)`（当前默认约 2%）。
      - **平滑放量**：`factor = clamp01((gap - diffuseGradientThreshold)/diffuseGradientScale)`，外流 `out = outMax × factor`。
      - **分配方式**：按**能量缺口（Deficit）**加权分配。`Deficit_j = max(0, cap_j - Energy_j)`，越饿的邻居分得越多；若所有邻居都满（总缺口=0）则均分。

   2. **渗透压扩散（饱腹度梯度）**：
      - **饱腹度**：`Fullness = Energy / maxEnergy(Gene)`（0~1）
      - **启动条件**：`Fullness_self - Avg(Fullness_neighbors) > osmosisGradientThreshold`（默认 0.06）
      - **外流上限**：`Energy_self × osmosisOutFrac`，其中 `osmosisOutFrac = osmosisNeighbor/(osmosisSelf+osmosisNeighbor)`（当前默认约 1%）。
      - **平滑放量**：`of = clamp01((fullGap - osmosisGradientThreshold)/osmosisGradientScale)`，外流 `outOsmosis = outMax × of`。
      - **分配方式**：按**能量缺口**加权分配；若总缺口=0 则均分。

   3. **溢出输血（Overflow share）**：
      - 在本 Tick 的收支结算后，若能量超过上限：`Overflow = max(0, Energy' - cap)`
      - 溢出中有一部分会被“输血”给周围活体植物邻居：`ShareOut = Overflow × overflowShareFrac`（当前默认 25%）
      - `ShareOut` 按**能量缺口**加权分配：越饿的邻居分得越多；若所有邻居都满则均分。接收后若仍超过 cap，则在"二次 cap"里截断。

      - 这是**一次性**输血：接收者不会在同 Tick 内再触发二次溢出输血（避免递归传播与计算爆炸）。

   > **直觉**：物理扩散偏“削峰”；渗透压扩散偏“按饱腹度均衡”。由于两者都按库存比例外流，它们的系数需要与光合/代谢量级匹配，避免过快抹平差异。

   > **调参直觉**：
   > - 想让群落互相“输血”更强（容易拉平差异）：增大扩散上限（`diffuseNeighbor`）、增大渗透压外流（`osmosisNeighbor`）、或增大溢出输血比例（`overflowShareFrac`）。
   > - 想让能量更“黏”（内部保持贫富差距）：减小上限或增大启动阈值。

## 3. 密度压力与能量惩罚（拥挤与孤独机制）

Bio-Grid 采用**能量耗尽才凋亡**的抗压机制。不论是过度拥挤还是过度孤独，都会增加能量消耗。

1. **局部拥挤（微观）**
如果一个细胞周围 8 个邻居中，“活体植物”的数量**大于 4 个**（即有 5 到 8 个活体植物邻居时），该细胞会受到局部拥挤惩罚。由于自然界中的资源竞争（如遮光、抢水）往往是非线性的，因此超出 4 个后的密度惩罚会**加速增长**。
- 惩罚计算：`LocalCrowd = Max(0, 邻居数 - 4)`
- 局部能量流失：`CrowdFactor(LocalCrowd) * 0.0008`
  - 5 个邻居（超1）：流失 `1 * 0.0008 = 0.0008`（可感知的额外压力）
  - 6 个邻居（超2）：流失 `2 * 0.0008 = 0.0016`（强压）
  - 7 个邻居（超3）：流失 `10 * 0.0008 = 0.008`（致死级压力）
  - 8 个邻居（超4）：流失 `37 * 0.0008 = 0.0296`（极端高压）

2. **孤独惩罚（微观）**
如果一个细胞周围 8 个邻居中，“活体植物”的数量**小于 2 个**（即只有 0 或 1 个活体植物邻居时），该细胞会因为缺乏群落的微气候保护而受到孤独惩罚。
- 孤独能量流失：`0.005 * NeighborFactor * GeneFactor`
  - `NeighborFactor = (邻居数为 0 ? 2 : 1)`（0 个邻居翻倍）
  - `GeneFactor = 0.4 + Gene * 1.2`（低基因更耐孤独，高基因更吃亏）

其中“活体植物”在实现中等价于 `Type = PLANT`（并由实现保证其 `Biomass > 0`；不会出现 `Type = PLANT` 但 `Biomass <= 0` 的稳定状态）。

> **结论**：高密度或孤独都不会导致细胞立刻“爆体而亡”。而是会让细胞的能量消耗增加。只有当这些惩罚彻底把细胞的能量（Energy）抽干后，才会触发下文的凋亡逻辑。

## 4. 生长与凋亡（Biomass 结算）

在结算完所有能量的收入、基础开销与密度惩罚后，会得出细胞最终的剩余能量。

- **生长**：只有当最终 `Energy > 6`（`growthEnergyThreshold`）时，细胞才真正处于“有余粮”的顺境，其生物量（Biomass）会增加 `0.004`，最高不超过该细胞的基因决定的 `maxBiomass`（保守型 1.8，激进型 1.0）。
- **维持**：如果最终 `0 < Energy <= 6`，细胞能活但没有足够“盈余”长肉，Biomass 保持不变。
- **凋亡**：如果最终 `Energy <= 0`，细胞不仅能量归零，还会开始消耗“肉体”来抵债，其生物量（Biomass）会扣除 `0.0004`（这给细胞留出了等待日出或熬过干旱的缓冲时间，而不是瞬间暴毙）。
- **死亡判定**：如果由于持续的能量枯竭，导致 `Biomass <= 0`，则该细胞彻底死亡，状态变为 `EMPTY`，基因与能量清零。

## 5. 繁衍与突变（双亲繁殖）

想要繁衍必须同时满足六个苛刻的条件：
1. **成熟度**：自身的生物量（Biomass）必须大于自身生物量上限的 50%（`reproBiomassRatio = 0.5`）。因此胖（低基因）细胞需要更久才能长到成熟期。
2. **能量储备**：自身的能量（Energy）必须大于自身能量上限的 20%（`reproEnergyRatio = 0.2`）。
3. **未衰老**：必须不在衰老期（即 `age <= maxAge × 0.7`），衰老期的细胞不再繁衍。
4. **周围有空地**：8 邻域内至少有一个空地（EMPTY）。
5. **不拥挤**：自身的 8 邻域内植物邻居数量必须 <= 4。
6. **有合格的伴侣**：目标空地的周围，除了自身之外，必须还有至少另一个植物邻居同样满足上述的“成熟度”、"能量储备"与"未衰老"条件。

如果满足以上条件，细胞会进行分裂：
- **产生后代**：随机选中满足上述条件的一个空地，生成新的细胞（也就是说，这个空地是由两个合格的母体共同孕育的）。
- **初始数值**：后代诞生时的初始生物量为 0.32。
- **能量平分**：两个母体将当前能量的四分之一（25%）分给后代，自己保留剩下四分之三。
- **基因突变**：后代会随机继承两个母体其中之一的基因，但带有随机突变波动。**突变的范围与双亲的基因差异正相关**：
  - 基因相近的亲本繁殖（近亲），产生的后代突变极小（基因组合稳定）。
  - 基因差异大的亲本繁殖（远交），产生的后代突变范围很大（可能产生极端的变异）。
  - 实际突变步长 = `基础突变(0.01) + 双亲基因差值 × 差异系数(0.1)`

## 6. 特殊网格：墙体（WALL）
- 墙体无法生长、死亡或繁衍。
- 墙体能量永久为 0。
- 墙体绝对**不参与**邻居的能量扩散与平均值计算（阻断能量流动）。
- 玩家可在面板中选择“墙体”模式，用鼠标左键拖动绘制，或使用预设地图，从而人为构造出“生态隔离舱”。

## 7. 配置参数说明
- 配置参数定义在 `src/config.js` 中。

## 8. 规则实现映射（高内聚低耦合）
- 生态规则计算集中在 `src/sim/`（`tick.js`、`brush.js`、`world.js`、`presets.js`）。
- Worker 只做调度与消息分发：`src/workers/sim-worker/index.js`。
- Worker 内部职责拆分：
  - `src/workers/sim-worker/snapshots.js`：快照与 SharedArrayBuffer 发布。
  - `src/workers/sim-worker/render.js`：OffscreenCanvas 渲染。
  - `src/workers/sim-worker/terrain.js`：地形笔刷与统一地形重置。
  - `src/workers/sim-worker/history.js`：地形编辑撤销/重做历史。
- 主线程只做编排与交互：`src/main.js`，DOM 与标签页逻辑分别在 `src/main-dom.js`、`src/main-tabs.js`。

## 9. 每 Tick 的“能量账本”总表（强烈建议对照调参）

下面这张表把 **一个植物格子** 在每个 Tick 内的所有“收入 / 支出 / 转移”一次性列全。它不是新增规则，而是对前文规则的“汇总版”，便于你从全局角度判断压力来源与调参方向。

### 9.1 单格总账（把所有“加项/减项”一次列全）

下面用“一个植物格子 i”为单位，把它在一个 Tick 内的能量变化写成更直观的“总收入 / 总支出”形式。注意：**扩散发生在收支结算之前**，并且扩散项依赖邻居，因此用文字名（而不是硬塞一条超长公式）更清晰。

#### A) 本 Tick 的总收入（所有加号项）

- **扩散流入**：`DiffuseIn(i)`  
  - 来自邻居对 i 的两种扩散：**物理扩散（绝对能量梯度）** + **渗透压扩散（饱腹度梯度）**
- **光合作用收入**：`Income(i)`  
  - `LocalSunlight = Sunlight × TerrainLight[i]`  
  - `Income = LocalSunlight × (photoIncomeBase + Gene × photoIncomeGeneFactor)`
- **溢出输血流入**：`OverflowIn(i)`  
  - 来自邻居的“溢出分红/输血”（见下方 C 部分）

#### B) 本 Tick 的总支出（所有减号项）

- **扩散流出**：`DiffuseOut(i)`  
  - i 对邻居的两种扩散外流：物理扩散 + 渗透压扩散
- **代谢支出（含衰老）**：`Cost(i)`
  - `Cost0 = baseCost × TerrainLoss[i] + Gene² × geneCostFactor`
  - `Cost = Cost0 + Cost0 × senescenceCostExtraMultiplier × t`（t 为衰老进度）
- **孤独惩罚**：`IsolationLoss(i)`（活体植物邻居数 < 2）
- **拥挤惩罚**：`CrowdLoss(i)`（活体植物邻居数 > 4）

#### C) 本 Tick 的能量主公式（含 cap 与溢出输血）

1. **扩散结算后的能量**（扩散不凭空生能，是邻里再分配）：

`Energy_afterDiffuse = Energy_prev + DiffuseIn(i) - DiffuseOut(i)`

2. **本格收支结算**（不含繁殖）：

`Energy_raw = Energy_afterDiffuse + Income(i) - Cost(i) - IsolationLoss(i) - CrowdLoss(i)`

3. **能量上限与溢出**（cap 与“输血来源”）：

- `cap = maxEnergy(Gene) = energyMaxBase - Gene × energyMaxGeneRange`
- `Energy_capped = min(Energy_raw, cap)`
- `Overflow = max(0, Energy_raw - cap)`（这部分原本会被 cap 丢弃）

4. **溢出输血（一次性，不递归）**：

- `ShareOut = Overflow × overflowShareFrac`（默认 25%）
- `ShareOut` 按能量缺口加权分配给周围活体植物邻居，形成它们的 `OverflowIn`
- 接收者在本 Tick 内**不会**触发二次溢出输血；若接收后仍超过 cap，只会在“二次 cap”中被截断

5. **接收输血后再次 cap（得到最终能量）**：

`Energy_next = min(Energy_capped + OverflowIn(i), cap)`

> 这套写法的好处是：你调参时可以直接看“哪一项是加号、哪一项是减号”，并且能明确区分三类群落交互：扩散（流入/流出）、溢出输血（原本要浪费的能量再分配）、以及本格代谢/惩罚（局地压力）。

### 9.5 能量扩散（群落内部的守恒转移）

扩散不直接“凭空生出”能量，但允许把原本会被 cap 丢弃的溢出能量的一部分重新分配（溢出分红）。这里“活体植物”严格定义为：`Type = PLANT` 且 `Biomass > 0`。

扩散由两个“梯度项”组成（实现见 `src/sim/tick.js`）：

1. **物理扩散（绝对能量梯度）**：
   - 只在 `Energy_self > 0` 且 `Energy_self - Avg(Energy_neighbors) > diffuseGradientThreshold` 时外流
   - 外流上限：`Energy_self × outFrac`，其中 `outFrac = diffuseNeighbor/(diffuseSelf+diffuseNeighbor)`
   - 放量：`factor = clamp01((gap - diffuseGradientThreshold)/diffuseGradientScale)`

2. **渗透压扩散（饱腹度梯度）**：
   - 定义饱腹度：`Fullness = Energy / maxEnergy(Gene)`（0~1）
   - 只在 `Fullness_self - Avg(Fullness_neighbors) > osmosisGradientThreshold`（默认 0.06）时外流
   - 外流上限：`Energy_self × osmosisOutFrac`，其中 `osmosisOutFrac = osmosisNeighbor/(osmosisSelf+osmosisNeighbor)`
   - 放量：`of = clamp01((fullGap - osmosisGradientThreshold)/osmosisGradientScale)`

两项外流量相加后，按**能量缺口**加权分配给活体植物邻居（`Deficit = max(0, cap - Energy)`）；若总缺口=0 则均分；若没有活体植物邻居则不外流。

### 9.5.1 溢出分红（Overflow share）

当某格在本 Tick 的收支结算后出现溢出：

- `Overflow = max(0, Energy' - cap)`
- 分红总额：`ShareOut = Overflow × overflowShareFrac`
- `ShareOut` 按**能量缺口**加权分配：`Deficit_j = max(0, cap_j - Energy_j)`，越饿的邻居分得越多；若所有邻居都满则均分
- 这是**一次性**的再分配：接收分红后若再次超过 cap，只会在“二次 cap”中被截断，不会再触发二次分红（避免递归与无限传播）。

### 9.6 生物量结算（Biomass）

基于 cap 后的 `Energy_next`：

- 若 `Energy_next > growthEnergyThreshold`：`Biomass += growthRate`
- 若 `0 < Energy_next <= growthEnergyThreshold`：`Biomass += 0`
- 若 `Energy_next <= 0`：`Biomass -= decayRate`

并且有上限（由基因决定）：

- `maxBiomass(Gene) = biomassMaxBase - Gene × biomassMaxGeneRange`
- `Biomass_next = clamp(0..maxBiomass, Biomass_next)`

### 9.7 繁殖的能量转移（Energy transfer）

当满足成熟度/能量/伴侣/空地/不拥挤等条件后：

- 子代能量 = `parent1Share + parent2Share`
- 每个亲本让出：`parentShare = parentEnergy × reproEnergyShareFrac`

> 注意：繁殖不是“额外收入”，它是群落内部能量在亲本与子代之间的一次转移与重分配。
