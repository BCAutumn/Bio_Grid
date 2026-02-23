"""Tick 逻辑 - 与 src/sim/tick.js 完全对齐

Phase 1 实现策略（严格档）：
- Phase 1-2.8: 使用 NumPy 向量化（可后续迁移到 Taichi kernel）
- Phase 3 (繁殖): CPU 顺序执行（保证 RNG 调用顺序与 JS 一致）
- Phase 4: 死亡清理

阶段顺序（不可变）：
1. 扩散 (diffusion)
2. 代谢结算/cap/overflowOut
2.5. overflowShare
2.8. 二次 cap + 生物量结算 + reproEligible
3. 繁殖（能量转移）
4. 死亡清理 + 缓冲翻转
"""

import numpy as np
from typing import Callable, Optional

from .state import World, Grid, CellType, MAX_NEIGHBOR_COUNT, RNG_MAX_OPEN
from .config import Config


def tick(world: World, rng: Optional[Callable[[], float]] = None) -> dict:
    """执行一个 tick - 与 JS tick() 完全对齐

    Args:
        world: 世界状态
        rng: 随机数生成器函数，返回 [0, 1)。如果为 None 则使用 numpy.random

    Returns:
        统计数据字典
    """
    if rng is None:
        rng = np.random.random

    config = world.config
    a = world.front  # 读缓冲
    b = world.back   # 写缓冲
    terrain = world.terrain
    size = world.size
    neighbor_indices = world.neighbors.indices
    neighbor_counts = world.neighbors.counts
    scratch = world.scratch

    # 类型常量
    WALL = CellType.WALL
    PLANT = CellType.PLANT
    EMPTY = CellType.EMPTY
    has_walls = world.wall_count > 0

    # 更新时间
    world.time += config.timeStep
    polar_day = config.polarDay
    raw_sunlight = 1.0 if polar_day else np.sin(world.time * config.sunSpeed)
    sunlight = max(0.0, raw_sunlight)
    world.sunlight = sunlight
    day_step = 0.0 if polar_day else (config.timeStep * config.sunSpeed) / (np.pi * 2)
    world.day = (world.day if np.isfinite(world.day) else 0.0) + day_step

    # 预计算配置参数
    diffuse_self = config.diffuseSelf
    diffuse_neighbor = config.diffuseNeighbor
    diffuse_gradient_threshold = config.diffuseGradientThreshold
    diffuse_gradient_scale = config.diffuseGradientScale
    norm = diffuse_self + diffuse_neighbor
    out_frac = diffuse_neighbor / norm if norm > 0 else 0.0

    osmosis_self = config.osmosisSelf
    osmosis_neighbor = config.osmosisNeighbor
    osmosis_gradient_threshold = config.osmosisGradientThreshold
    osmosis_gradient_scale = config.osmosisGradientScale
    osmosis_norm = osmosis_self + osmosis_neighbor
    osmosis_out_frac = osmosis_neighbor / osmosis_norm if osmosis_norm > 0 else 0.0

    base_cost = config.baseCost
    gene_cost_factor = config.geneCostFactor
    growth_energy_threshold = config.growthEnergyThreshold
    growth_rate = config.growthRate
    decay_rate = config.decayRate

    isolation_energy_loss = config.isolationEnergyLoss
    isolation_zero_neighbor_multiplier = config.isolationZeroNeighborMultiplier
    isolation_gene_base = config.isolationGeneBase
    isolation_gene_factor = config.isolationGeneFactor
    isolation_neighbor_min = config.isolationNeighborMin

    crowd_neighbor_soft = config.crowdNeighborSoft
    crowd_energy_loss = config.crowdEnergyLoss
    repro_neighbor_cap = config.reproNeighborCap
    repro_biomass_ratio = config.reproBiomassRatio
    repro_energy_ratio = config.reproEnergyRatio
    child_biomass = config.childBiomass
    mutation_step = config.mutationStep
    mutation_distance_factor = config.mutationDistanceFactor
    repro_energy_share_frac = config.reproEnergyShareFrac

    energy_max_base = config.energyMaxBase
    energy_max_gene_range = config.energyMaxGeneRange
    biomass_max_base = config.biomassMaxBase
    biomass_max_gene_range = config.biomassMaxGeneRange
    age_max_base = config.ageMaxBase
    age_max_gene_range = config.ageMaxGeneRange
    senescence_start_frac = config.senescenceStartFrac
    senescence_cost_extra_multiplier = config.senescenceCostExtraMultiplier
    photo_income_base = config.photoIncomeBase
    photo_income_gene_factor = config.photoIncomeGeneFactor

    raw_overflow_share_frac = config.overflowShareFrac
    overflow_share_frac = np.clip(raw_overflow_share_frac, 0.0, 1.0)

    overflow_out = scratch.overflow_out
    overflow_in = scratch.overflow_in
    repro_eligible = scratch.repro_eligible

    # 初始化写缓冲
    repro_eligible.fill(0)
    np.copyto(b.type, a.type)
    np.copyto(b.biomass, a.biomass)
    np.copyto(b.gene, a.gene)
    b.energy.fill(0)
    np.copyto(b.age, a.age)

    # 临时数组（用于邻居计算）
    diffuse_neighbors = np.zeros(8, dtype=np.int32)
    deficits = np.zeros(8, dtype=np.float32)

    # --- Phase 1: Diffusion ---
    for i in range(size):
        if has_walls and a.type[i] == WALL:
            continue
        if a.type[i] != PLANT:
            continue
        if a.biomass[i] <= 0:
            continue

        raw_self_e = a.energy[i]
        if raw_self_e <= 0:
            continue
        self_e = raw_self_e

        base = i * MAX_NEIGHBOR_COUNT
        neighbor_count = neighbor_counts[i]

        deg = 0
        neighbor_e_sum = 0.0
        neighbor_full_sum = 0.0

        raw_self_gene = a.gene[i]
        self_gene = np.clip(raw_self_gene, 0.0, 1.0)
        self_max_e = energy_max_base - self_gene * energy_max_gene_range
        self_full = self_e / self_max_e if self_max_e > 0 else 0.0

        for n in range(neighbor_count):
            ni = neighbor_indices[base + n]
            if has_walls and a.type[ni] == WALL:
                continue
            if a.type[ni] != PLANT:
                continue
            if a.biomass[ni] <= 0:
                continue

            diffuse_neighbors[deg] = ni
            deg += 1

            ne = a.energy[ni]
            neighbor_e_sum += max(0.0, ne)

            raw_ng = a.gene[ni]
            ng = np.clip(raw_ng, 0.0, 1.0)
            n_max_e = energy_max_base - ng * energy_max_gene_range
            n_pos_e = max(0.0, ne)
            neighbor_full_sum += (n_pos_e / n_max_e) if n_max_e > 0 else 0.0

        if deg > 0:
            neighbor_avg_e = neighbor_e_sum / deg
            gap = self_e - neighbor_avg_e

            factor = 0.0
            if gap > diffuse_gradient_threshold:
                if diffuse_gradient_scale > 0:
                    factor = (gap - diffuse_gradient_threshold) / diffuse_gradient_scale
                else:
                    factor = 1.0
                factor = np.clip(factor, 0.0, 1.0)

            out_physical = (self_e * out_frac) * factor

            # 渗透压扩散
            out_osmosis = 0.0
            if osmosis_out_frac > 0:
                neighbor_avg_full = neighbor_full_sum / deg
                full_gap = self_full - neighbor_avg_full
                of = 0.0
                if full_gap > osmosis_gradient_threshold:
                    if osmosis_gradient_scale > 0:
                        of = (full_gap - osmosis_gradient_threshold) / osmosis_gradient_scale
                    else:
                        of = 1.0
                    of = np.clip(of, 0.0, 1.0)
                out_osmosis = (self_e * osmosis_out_frac) * of

            out = min(out_physical + out_osmosis, self_e)
            b.energy[i] += self_e - out

            # 按能量缺口加权分配
            total_deficit = 0.0
            for k in range(deg):
                ni = diffuse_neighbors[k]
                raw_ng = a.gene[ni]
                ng = np.clip(raw_ng, 0.0, 1.0)
                n_max_e = energy_max_base - ng * energy_max_gene_range
                ne = a.energy[ni]
                ne_pos = max(0.0, ne)
                deficit = max(0.0, n_max_e - ne_pos) if n_max_e > 0 else 0.0
                deficits[k] = deficit
                total_deficit += deficit

            for k in range(deg):
                ni = diffuse_neighbors[k]
                if total_deficit > 0:
                    share = out * (deficits[k] / total_deficit)
                else:
                    share = out / deg
                b.energy[ni] += share
        else:
            b.energy[i] += self_e

    # --- Phase 2: Income/cost -> cap + overflow capture ---
    overflow_out.fill(0)
    overflow_in.fill(0)

    for i in range(size):
        if a.type[i] != PLANT:
            continue
        if a.biomass[i] <= 0:
            b.energy[i] = 0
            b.gene[i] = 0
            b.age[i] = 0
            b.biomass[i] = 0
            overflow_out[i] = 0
            repro_eligible[i] = 0
            continue

        raw_gene = a.gene[i]
        gene = np.clip(raw_gene, 0.0, 1.0)
        age = (a.age[i] or 0) + day_step
        cell_max_age = age_max_base + (1.0 - gene) * age_max_gene_range

        # 老死判定
        if age >= cell_max_age:
            b.energy[i] = 0
            b.biomass[i] = 0
            b.gene[i] = 0
            b.age[i] = 0
            overflow_out[i] = 0
            repro_eligible[i] = 0
            continue

        # 光合作用收入
        local_sunlight = sunlight * terrain.light[i]
        income = local_sunlight * (photo_income_base + gene * photo_income_gene_factor)

        # 代谢支出
        base_cost_scaled = base_cost * terrain.loss[i]
        cost0 = base_cost_scaled + gene * gene * gene_cost_factor

        # 衰老加成
        senescence_denom = cell_max_age * (1.0 - senescence_start_frac)
        if senescence_denom > 0:
            senescence_t = max(0.0, (age - cell_max_age * senescence_start_frac) / senescence_denom)
        else:
            senescence_t = 0.0
        cost = cost0 + cost0 * senescence_cost_extra_multiplier * senescence_t

        energy = b.energy[i] + income - cost

        # 统计植物邻居数
        plant_neighbors = 0
        base = i * MAX_NEIGHBOR_COUNT
        neighbor_count = neighbor_counts[i]
        for n in range(neighbor_count):
            ni = neighbor_indices[base + n]
            if a.type[ni] == PLANT:
                plant_neighbors += 1

        # 孤独惩罚
        if plant_neighbors < isolation_neighbor_min:
            neighbor_factor = isolation_zero_neighbor_multiplier if plant_neighbors == 0 else 1.0
            gene_factor = isolation_gene_base + gene * isolation_gene_factor
            energy -= isolation_energy_loss * neighbor_factor * gene_factor
        # 拥挤惩罚
        elif plant_neighbors > crowd_neighbor_soft:
            local_crowd = plant_neighbors - crowd_neighbor_soft
            crowd_factors = [0, 1, 2, 10, 37]
            crowd_factor = crowd_factors[local_crowd] if local_crowd < len(crowd_factors) else ((2 ** local_crowd) - 1)
            energy -= crowd_factor * crowd_energy_loss

        b.gene[i] = gene
        b.age[i] = age

        cell_max_energy = energy_max_base - gene * energy_max_gene_range
        if energy > cell_max_energy:
            overflow_out[i] = energy - cell_max_energy
            b.energy[i] = cell_max_energy
        else:
            overflow_out[i] = 0
            b.energy[i] = energy

    # --- Phase 2.5: Overflow sharing ---
    if overflow_share_frac > 0:
        for i in range(size):
            if a.type[i] != PLANT:
                continue
            if a.biomass[i] <= 0:
                continue
            ov = overflow_out[i]
            if ov <= 0:
                continue

            base = i * MAX_NEIGHBOR_COUNT
            neighbor_count = neighbor_counts[i]
            deg = 0

            for n in range(neighbor_count):
                ni = neighbor_indices[base + n]
                if has_walls and a.type[ni] == WALL:
                    continue
                if a.type[ni] != PLANT:
                    continue
                if a.biomass[ni] <= 0:
                    continue
                diffuse_neighbors[deg] = ni
                deg += 1

            if deg <= 0:
                continue

            share_total = ov * overflow_share_frac
            if share_total <= 0:
                continue

            # 按能量缺口加权分配
            total_deficit = 0.0
            for k in range(deg):
                ni = diffuse_neighbors[k]
                raw_ng = b.gene[ni]
                ng = np.clip(raw_ng, 0.0, 1.0)
                n_max_e = energy_max_base - ng * energy_max_gene_range
                ne = b.energy[ni]
                deficit = max(0.0, n_max_e - ne) if n_max_e > 0 else 0.0
                deficits[k] = deficit
                total_deficit += deficit

            for k in range(deg):
                ni = diffuse_neighbors[k]
                if total_deficit > 0:
                    share = share_total * (deficits[k] / total_deficit)
                else:
                    share = share_total / deg
                overflow_in[ni] += share

    # --- Phase 2.8: Apply overflow -> cap again -> biomass + repro eligibility ---
    for i in range(size):
        if a.type[i] != PLANT:
            continue
        if b.biomass[i] <= 0:
            repro_eligible[i] = 0
            continue

        gene = b.gene[i]
        age = b.age[i] or 0
        cell_max_energy = energy_max_base - gene * energy_max_gene_range
        cell_max_biomass = biomass_max_base - gene * biomass_max_gene_range

        energy = b.energy[i] + overflow_in[i]
        if energy > cell_max_energy:
            energy = cell_max_energy
        b.energy[i] = energy

        # 生物量结算
        if energy > growth_energy_threshold:
            biomass_delta = growth_rate
        elif energy <= 0:
            biomass_delta = -decay_rate
        else:
            biomass_delta = 0

        next_biomass_raw = b.biomass[i] + biomass_delta
        next_biomass = np.clip(next_biomass_raw, 0.0, cell_max_biomass)
        b.biomass[i] = next_biomass

        # 繁殖资格
        cell_max_age = age_max_base + (1.0 - gene) * age_max_gene_range
        if (next_biomass > cell_max_biomass * repro_biomass_ratio and
            energy > cell_max_energy * repro_energy_ratio and
            age <= cell_max_age * senescence_start_frac):
            repro_eligible[i] = 1
        else:
            repro_eligible[i] = 0

    # --- Phase 3: Reproduction (CPU 顺序执行，保证 RNG 对齐) ---
    empty_neighbors = np.zeros(8, dtype=np.int32)

    for i in range(size):
        if b.type[i] != PLANT:
            continue
        if not repro_eligible[i]:
            continue
        if b.biomass[i] <= 0:
            continue

        gene = b.gene[i]
        cell_max_energy = energy_max_base - gene * energy_max_gene_range
        cell_max_biomass = biomass_max_base - gene * biomass_max_gene_range
        energy_now = b.energy[i]
        biomass_now = b.biomass[i]

        if not (biomass_now > cell_max_biomass * repro_biomass_ratio and
                energy_now > cell_max_energy * repro_energy_ratio):
            continue

        # 统计邻居
        plant_neighbors = 0
        empty_count = 0
        base = i * MAX_NEIGHBOR_COUNT
        neighbor_count = neighbor_counts[i]

        for n in range(neighbor_count):
            ni = neighbor_indices[base + n]
            if b.type[ni] == PLANT and b.biomass[ni] > 0:
                plant_neighbors += 1
            if b.type[ni] == EMPTY:
                empty_neighbors[empty_count] = ni
                empty_count += 1

        if empty_count <= 0:
            continue
        if plant_neighbors < 1 or plant_neighbors > repro_neighbor_cap:
            continue

        # Reservoir sampling 选择空地和伴侣
        chosen_empty = -1
        chosen_co_parent = -1
        valid_empty_count = 0

        for k in range(empty_count):
            empty = empty_neighbors[k]

            # 在空地周围找合格伴侣
            co_parent = -1
            co_parent_count = 0
            empty_base = empty * MAX_NEIGHBOR_COUNT
            empty_neighbor_count = neighbor_counts[empty]

            for n in range(empty_neighbor_count):
                ni = neighbor_indices[empty_base + n]
                if ni == i:
                    continue
                if b.type[ni] != PLANT:
                    continue
                if b.biomass[ni] <= 0:
                    continue
                if not repro_eligible[ni]:
                    continue

                co_parent_count += 1
                roll = rng()
                bounded_roll = roll if roll < 1 else RNG_MAX_OPEN
                if int(bounded_roll * co_parent_count) == 0:
                    co_parent = ni

            if co_parent < 0:
                continue

            valid_empty_count += 1
            roll = rng()
            bounded_roll = roll if roll < 1 else RNG_MAX_OPEN
            if int(bounded_roll * valid_empty_count) != 0:
                continue

            chosen_empty = empty
            chosen_co_parent = co_parent

        if chosen_empty < 0:
            continue

        # 能量转移
        parent1_energy = b.energy[i]
        parent1_share = parent1_energy * repro_energy_share_frac
        raw_parent2_energy = b.energy[chosen_co_parent]
        parent2_energy = max(0.0, raw_parent2_energy)
        parent2_share = parent2_energy * repro_energy_share_frac

        # 创建后代
        b.type[chosen_empty] = PLANT
        b.biomass[chosen_empty] = child_biomass
        b.energy[chosen_empty] = parent1_share + parent2_share
        b.age[chosen_empty] = 0
        repro_eligible[chosen_empty] = 0

        # 基因继承与突变
        co_parent_gene = b.gene[chosen_co_parent]
        parent_pick_roll = rng()
        parent_gene = gene if parent_pick_roll < 0.5 else co_parent_gene
        gene_diff = abs(gene - co_parent_gene)
        actual_mutation_step = mutation_step + gene_diff * mutation_distance_factor
        mutation_roll = rng()
        child_gene_raw = parent_gene + (mutation_roll * 2 - 1) * actual_mutation_step
        b.gene[chosen_empty] = np.clip(child_gene_raw, 0.0, 1.0)

        # 扣除亲本能量
        b.energy[i] = parent1_energy - parent1_share
        b.energy[chosen_co_parent] -= parent2_share

    # --- Phase 4: Death clearing ---
    for i in range(size):
        if b.type[i] != PLANT:
            continue
        if b.biomass[i] > 0:
            continue
        b.type[i] = EMPTY
        b.energy[i] = 0
        b.biomass[i] = 0
        b.gene[i] = 0
        b.age[i] = 0

    # 交换缓冲
    world.swap_buffers()
    world.stats.tick += 1

    return {
        'tick': world.stats.tick,
        'time': world.time,
        'day': world.day,
        'sunlight': world.sunlight,
    }


def compute_stats(world: World) -> dict:
    """计算统计数据 - 与 JS computeStats 对齐"""
    front = world.front
    plant_mask = front.type == CellType.PLANT

    total_biomass = float(np.sum(front.biomass[plant_mask]))
    plant_count = int(np.sum(plant_mask))
    gene_sum = float(np.sum(front.gene[plant_mask]))
    avg_gene = gene_sum / plant_count if plant_count > 0 else 0.0

    world.stats.total_biomass = total_biomass
    world.stats.plant_count = plant_count
    world.stats.avg_gene = avg_gene

    return {
        'tick': world.stats.tick,
        'total_biomass': total_biomass,
        'plant_count': plant_count,
        'avg_gene': avg_gene,
    }
