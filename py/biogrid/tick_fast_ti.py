"""Taichi fast tick（阶段3：性能档）

说明：
- 该实现面向“丝滑可视化与大规模吞吐”，使用 Taichi kernel + atomic_add。
- 当前先覆盖 Phase 1/2/2.5/2.8/4（不含繁殖 Phase3）。
- 严格对齐（含繁殖 + RNG 序列一致）仍由 `biogrid.tick.tick()`（NumPy/Python）负责。
"""

import math
import taichi as ti

from .state import CellType, MAX_NEIGHBOR_COUNT
from .world_ti import WorldTI


@ti.data_oriented
class FastTicker:
    def __init__(self, width: int, height: int):
        self.width = int(width)
        self.height = int(height)
        self.size = self.width * self.height

    @staticmethod
    @ti.func
    def _clamp01(x):
        return ti.min(1.0, ti.max(0.0, x))

    @staticmethod
    @ti.func
    def _hash_u32(x):
        # 32-bit mix（与 JS render.js 的 phaseFromIndex 同系思路）
        x = ti.cast(x, ti.u32)
        x ^= x >> 16
        x *= ti.u32(0x85ebca6b)
        x ^= x >> 13
        x *= ti.u32(0xc2b2ae35)
        x ^= x >> 16
        return x

    @classmethod
    @ti.func
    def _rand01(cls, a, b, c, d):
        # 基于 4 个输入生成 [0,1) 随机数（不追求与 strict RNG 对齐，只用于 fast 模式）
        h = ti.u32(a) * ti.u32(0x9e3779b9) ^ ti.u32(b) * ti.u32(0x85ebca6b)
        h ^= ti.u32(c) * ti.u32(0xc2b2ae35)
        h ^= ti.u32(d) * ti.u32(0x27d4eb2f)
        h = cls._hash_u32(h)
        return ti.cast(h, ti.f32) / 4294967296.0

    @ti.kernel
    def _init_write_buffer(self,
                           a_type: ti.types.ndarray(dtype=ti.u8),
                           a_biomass: ti.types.ndarray(dtype=ti.f32),
                           a_gene: ti.types.ndarray(dtype=ti.f32),
                           a_age: ti.types.ndarray(dtype=ti.f32),
                           b_type: ti.types.ndarray(dtype=ti.u8),
                           b_biomass: ti.types.ndarray(dtype=ti.f32),
                           b_gene: ti.types.ndarray(dtype=ti.f32),
                           b_age: ti.types.ndarray(dtype=ti.f32),
                           b_energy: ti.types.ndarray(dtype=ti.f32),
                           repro_eligible: ti.types.ndarray(dtype=ti.u8)):
        for i in range(self.size):
            repro_eligible[i] = 0
            b_type[i] = a_type[i]
            b_biomass[i] = a_biomass[i]
            b_gene[i] = a_gene[i]
            b_age[i] = a_age[i]
            b_energy[i] = 0.0

    @ti.kernel
    def _phase1_diffusion(self,
                          a_type: ti.types.ndarray(dtype=ti.u8),
                          a_biomass: ti.types.ndarray(dtype=ti.f32),
                          a_energy: ti.types.ndarray(dtype=ti.f32),
                          a_gene: ti.types.ndarray(dtype=ti.f32),
                          b_energy: ti.types.ndarray(dtype=ti.f32),
                          neighbor_indices: ti.types.ndarray(dtype=ti.i32),
                          neighbor_counts: ti.types.ndarray(dtype=ti.u8),
                          diffuse_gradient_threshold: ti.f32, diffuse_gradient_scale: ti.f32, out_frac: ti.f32,
                          osmosis_out_frac: ti.f32, osmosis_gradient_threshold: ti.f32, osmosis_gradient_scale: ti.f32,
                          energy_max_base: ti.f32, energy_max_gene_range: ti.f32):
        PLANT = ti.u8(CellType.PLANT)
        WALL = ti.u8(CellType.WALL)

        for i in range(self.size):
            if a_type[i] == WALL:
                continue
            if a_type[i] != PLANT:
                continue
            if a_biomass[i] <= 0:
                continue
            raw_self_e = a_energy[i]
            if raw_self_e <= 0:
                continue

            self_e = raw_self_e
            base = i * MAX_NEIGHBOR_COUNT
            ncnt = ti.cast(neighbor_counts[i], ti.i32)

            # 先收集邻居统计（活体植物）
            deg = 0
            neighbor_e_sum = 0.0
            neighbor_full_sum = 0.0

            raw_self_g = a_gene[i]
            self_g = ti.min(1.0, ti.max(0.0, raw_self_g))
            self_max_e = energy_max_base - self_g * energy_max_gene_range
            self_full = self_e / self_max_e if self_max_e > 0 else 0.0

            neigh = ti.Vector([0] * 8, dt=ti.i32)
            for n in range(MAX_NEIGHBOR_COUNT):
                if n >= ncnt:
                    continue
                ni = neighbor_indices[base + n]
                if a_type[ni] == WALL:
                    continue
                if a_type[ni] != PLANT:
                    continue
                if a_biomass[ni] <= 0:
                    continue
                neigh[deg] = ni
                deg += 1
                ne = a_energy[ni]
                neighbor_e_sum += ti.max(0.0, ne)
                raw_ng = a_gene[ni]
                ng = ti.min(1.0, ti.max(0.0, raw_ng))
                n_max_e = energy_max_base - ng * energy_max_gene_range
                n_pos_e = ti.max(0.0, ne)
                neighbor_full_sum += (n_pos_e / n_max_e) if n_max_e > 0 else 0.0

            if deg <= 0:
                ti.atomic_add(b_energy[i], self_e)
                continue

            neighbor_avg_e = neighbor_e_sum / ti.cast(deg, ti.f32)
            gap = self_e - neighbor_avg_e
            factor = 0.0
            if gap > diffuse_gradient_threshold:
                factor = (gap - diffuse_gradient_threshold) / diffuse_gradient_scale if diffuse_gradient_scale > 0 else 1.0
                factor = self._clamp01(factor)
            out_physical = (self_e * out_frac) * factor

            out_osmosis = 0.0
            if osmosis_out_frac > 0:
                neighbor_avg_full = neighbor_full_sum / ti.cast(deg, ti.f32)
                full_gap = self_full - neighbor_avg_full
                of = 0.0
                if full_gap > osmosis_gradient_threshold:
                    of = (full_gap - osmosis_gradient_threshold) / osmosis_gradient_scale if osmosis_gradient_scale > 0 else 1.0
                    of = self._clamp01(of)
                out_osmosis = (self_e * osmosis_out_frac) * of

            out = out_physical + out_osmosis
            if out > self_e:
                out = self_e

            ti.atomic_add(b_energy[i], self_e - out)

            # 缺口加权分配
            deficits = ti.Vector([0.0] * 8, dt=ti.f32)
            total_def = 0.0
            for k in range(8):
                if k >= deg:
                    continue
                ni = neigh[k]
                raw_ng = a_gene[ni]
                ng = ti.min(1.0, ti.max(0.0, raw_ng))
                n_max_e = energy_max_base - ng * energy_max_gene_range
                ne = ti.max(0.0, a_energy[ni])
                d = ti.max(0.0, n_max_e - ne) if n_max_e > 0 else 0.0
                deficits[k] = d
                total_def += d

            for k in range(8):
                if k >= deg:
                    continue
                ni = neigh[k]
                share = out * (deficits[k] / total_def) if total_def > 0 else out / ti.cast(deg, ti.f32)
                ti.atomic_add(b_energy[ni], share)

    @ti.kernel
    def _phase2_income_cost_cap(self,
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
                                terrain_light: ti.types.ndarray(dtype=ti.f32),
                                terrain_loss: ti.types.ndarray(dtype=ti.f32),
                                neighbor_indices: ti.types.ndarray(dtype=ti.i32),
                                neighbor_counts: ti.types.ndarray(dtype=ti.u8),
                                day_step: ti.f32, sunlight: ti.f32,
                                base_cost: ti.f32, gene_cost_factor: ti.f32,
                                isolation_energy_loss: ti.f32, isolation_zero_neighbor_multiplier: ti.f32,
                                isolation_gene_base: ti.f32, isolation_gene_factor: ti.f32, isolation_neighbor_min: ti.i32,
                                crowd_neighbor_soft: ti.i32, crowd_energy_loss: ti.f32,
                                repro_neighbor_cap: ti.i32,
                                energy_max_base: ti.f32, energy_max_gene_range: ti.f32,
                                age_max_base: ti.f32, age_max_gene_range: ti.f32,
                                senescence_start_frac: ti.f32, senescence_cost_extra_multiplier: ti.f32,
                                photo_income_base: ti.f32, photo_income_gene_factor: ti.f32,
                                overflow_out: ti.types.ndarray(dtype=ti.f32),
                                overflow_in: ti.types.ndarray(dtype=ti.f32)):
        PLANT = ti.u8(CellType.PLANT)

        for i in range(self.size):
            if a_type[i] != PLANT:
                continue
            if a_biomass[i] <= 0:
                b_energy[i] = 0.0
                b_gene[i] = 0.0
                b_age[i] = 0.0
                b_biomass[i] = 0.0
                overflow_out[i] = 0.0
                overflow_in[i] = 0.0
                continue

            raw_g = a_gene[i]
            g = ti.min(1.0, ti.max(0.0, raw_g))
            age = (a_age[i] + day_step) if a_age[i] > 0 else day_step
            cell_max_age = age_max_base + (1.0 - g) * age_max_gene_range
            if age >= cell_max_age:
                b_energy[i] = 0.0
                b_biomass[i] = 0.0
                b_gene[i] = 0.0
                b_age[i] = 0.0
                overflow_out[i] = 0.0
                overflow_in[i] = 0.0
                continue

            local_sun = sunlight * terrain_light[i]
            income = local_sun * (photo_income_base + g * photo_income_gene_factor)
            cost0 = base_cost * terrain_loss[i] + (g * g) * gene_cost_factor
            sen_denom = cell_max_age * (1.0 - senescence_start_frac)
            sen_t = ti.max(0.0, (age - cell_max_age * senescence_start_frac) / sen_denom) if sen_denom > 0 else 0.0
            cost = cost0 + cost0 * senescence_cost_extra_multiplier * sen_t

            energy = b_energy[i] + income - cost

            # 邻居植物数（与 JS：按 type=PLANT 计数）
            base = i * MAX_NEIGHBOR_COUNT
            ncnt = ti.cast(neighbor_counts[i], ti.i32)
            plant_neighbors = 0
            for n in range(MAX_NEIGHBOR_COUNT):
                if n >= ncnt:
                    continue
                ni = neighbor_indices[base + n]
                if a_type[ni] == PLANT:
                    plant_neighbors += 1

            if plant_neighbors < isolation_neighbor_min:
                neighbor_factor = isolation_zero_neighbor_multiplier if plant_neighbors == 0 else 1.0
                gene_factor = isolation_gene_base + g * isolation_gene_factor
                energy -= isolation_energy_loss * neighbor_factor * gene_factor
            elif plant_neighbors > crowd_neighbor_soft:
                local_crowd = plant_neighbors - crowd_neighbor_soft
                crowd_factor = 0.0
                if local_crowd == 1:
                    crowd_factor = 1.0
                elif local_crowd == 2:
                    crowd_factor = 2.0
                elif local_crowd == 3:
                    crowd_factor = 10.0
                elif local_crowd == 4:
                    crowd_factor = 37.0
                else:
                    crowd_factor = (2.0 ** ti.cast(local_crowd, ti.f32)) - 1.0
                energy -= crowd_factor * crowd_energy_loss

            b_gene[i] = g
            b_age[i] = age
            cell_max_energy = energy_max_base - g * energy_max_gene_range
            if energy > cell_max_energy:
                overflow_out[i] = energy - cell_max_energy
                b_energy[i] = cell_max_energy
            else:
                overflow_out[i] = 0.0
                b_energy[i] = energy
            overflow_in[i] = 0.0

    @ti.kernel
    def _phase25_overflow_share(self,
                                a_type: ti.types.ndarray(dtype=ti.u8),
                                a_biomass: ti.types.ndarray(dtype=ti.f32),
                                b_energy: ti.types.ndarray(dtype=ti.f32),
                                b_gene: ti.types.ndarray(dtype=ti.f32),
                                neighbor_indices: ti.types.ndarray(dtype=ti.i32),
                                neighbor_counts: ti.types.ndarray(dtype=ti.u8),
                                overflow_out: ti.types.ndarray(dtype=ti.f32),
                                overflow_in: ti.types.ndarray(dtype=ti.f32),
                                overflow_share_frac: ti.f32,
                                energy_max_base: ti.f32, energy_max_gene_range: ti.f32):
        PLANT = ti.u8(CellType.PLANT)
        WALL = ti.u8(CellType.WALL)
        for i in range(self.size):
            if a_type[i] != PLANT:
                continue
            if a_biomass[i] <= 0:
                continue
            ov = overflow_out[i]
            if ov <= 0:
                continue

            base = i * MAX_NEIGHBOR_COUNT
            ncnt = ti.cast(neighbor_counts[i], ti.i32)
            neigh = ti.Vector([0] * 8, dt=ti.i32)
            deg = 0
            for n in range(MAX_NEIGHBOR_COUNT):
                if n >= ncnt:
                    continue
                ni = neighbor_indices[base + n]
                if a_type[ni] == WALL:
                    continue
                if a_type[ni] != PLANT:
                    continue
                if a_biomass[ni] <= 0:
                    continue
                neigh[deg] = ni
                deg += 1
            if deg <= 0:
                continue

            share_total = ov * overflow_share_frac
            if share_total <= 0:
                continue

            deficits = ti.Vector([0.0] * 8, dt=ti.f32)
            total_def = 0.0
            for k in range(8):
                if k >= deg:
                    continue
                ni = neigh[k]
                ng = ti.min(1.0, ti.max(0.0, b_gene[ni]))
                n_max_e = energy_max_base - ng * energy_max_gene_range
                ne = b_energy[ni]
                d = ti.max(0.0, n_max_e - ne) if n_max_e > 0 else 0.0
                deficits[k] = d
                total_def += d

            for k in range(8):
                if k >= deg:
                    continue
                ni = neigh[k]
                share = share_total * (deficits[k] / total_def) if total_def > 0 else share_total / ti.cast(deg, ti.f32)
                ti.atomic_add(overflow_in[ni], share)

    @ti.kernel
    def _phase28_apply_overflow_biomass(self,
                                        a_type: ti.types.ndarray(dtype=ti.u8),
                                        b_type: ti.types.ndarray(dtype=ti.u8),
                                        b_biomass: ti.types.ndarray(dtype=ti.f32),
                                        b_energy: ti.types.ndarray(dtype=ti.f32),
                                        b_gene: ti.types.ndarray(dtype=ti.f32),
                                        b_age: ti.types.ndarray(dtype=ti.f32),
                                        overflow_in: ti.types.ndarray(dtype=ti.f32),
                                        repro_eligible: ti.types.ndarray(dtype=ti.u8),
                                        growth_energy_threshold: ti.f32, growth_rate: ti.f32, decay_rate: ti.f32,
                                        repro_biomass_ratio: ti.f32, repro_energy_ratio: ti.f32,
                                        energy_max_base: ti.f32, energy_max_gene_range: ti.f32,
                                        biomass_max_base: ti.f32, biomass_max_gene_range: ti.f32,
                                        age_max_base: ti.f32, age_max_gene_range: ti.f32,
                                        senescence_start_frac: ti.f32):
        PLANT = ti.u8(CellType.PLANT)
        for i in range(self.size):
            if a_type[i] != PLANT:
                continue
            if b_biomass[i] <= 0:
                repro_eligible[i] = 0
                continue

            g = b_gene[i]
            age = b_age[i]
            cell_max_e = energy_max_base - g * energy_max_gene_range
            cell_max_b = biomass_max_base - g * biomass_max_gene_range
            energy = b_energy[i] + overflow_in[i]
            if energy > cell_max_e:
                energy = cell_max_e
            b_energy[i] = energy

            biomass_delta = growth_rate if energy > growth_energy_threshold else (-decay_rate if energy <= 0 else 0.0)
            nb = b_biomass[i] + biomass_delta
            if nb < 0:
                nb = 0.0
            elif nb > cell_max_b:
                nb = cell_max_b
            b_biomass[i] = nb

            cell_max_age = age_max_base + (1.0 - g) * age_max_gene_range
            repro_eligible[i] = 1 if (nb > cell_max_b * repro_biomass_ratio and energy > cell_max_e * repro_energy_ratio and age <= cell_max_age * senescence_start_frac) else 0

    @ti.kernel
    def _phase3_repro_claim(self,
                            b_type: ti.types.ndarray(dtype=ti.u8),
                            b_biomass: ti.types.ndarray(dtype=ti.f32),
                            b_energy: ti.types.ndarray(dtype=ti.f32),
                            b_gene: ti.types.ndarray(dtype=ti.f32),
                            b_age: ti.types.ndarray(dtype=ti.f32),
                            repro_eligible: ti.types.ndarray(dtype=ti.u8),
                            neighbor_indices: ti.types.ndarray(dtype=ti.i32),
                            neighbor_counts: ti.types.ndarray(dtype=ti.u8),
                            repro_claim: ti.types.ndarray(dtype=ti.i32),
                            tick_id: ti.i32,
                            repro_neighbor_cap: ti.i32,
                            energy_max_base: ti.f32, energy_max_gene_range: ti.f32,
                            biomass_max_base: ti.f32, biomass_max_gene_range: ti.f32,
                            repro_biomass_ratio: ti.f32, repro_energy_ratio: ti.f32,
                            age_max_base: ti.f32, age_max_gene_range: ti.f32,
                            senescence_start_frac: ti.f32):
        """Phase3（fast）：每个 eligible parent 选择一个空地并对空地做 atomic_min claim。

        说明：这里不追求与 strict 的随机序列一致，只保证规则条件一致，并且每个 parent 至多 claim 1 个空地。
        """
        PLANT = ti.u8(CellType.PLANT)
        EMPTY = ti.u8(CellType.EMPTY)

        # 先清空 claim（sentinel = 2^31-1）
        sentinel = ti.i32(2147483647)
        for i in range(self.size):
            repro_claim[i] = sentinel

        for i in range(self.size):
            if b_type[i] != PLANT:
                continue
            if b_biomass[i] <= 0:
                continue
            if repro_eligible[i] == 0:
                continue

            g = b_gene[i]
            energy_now = b_energy[i]
            biomass_now = b_biomass[i]
            cell_max_e = energy_max_base - g * energy_max_gene_range
            cell_max_b = biomass_max_base - g * biomass_max_gene_range
            if not (biomass_now > cell_max_b * repro_biomass_ratio and energy_now > cell_max_e * repro_energy_ratio):
                continue

            # 邻居植物数与空地数（按 b buffer）
            base = i * MAX_NEIGHBOR_COUNT
            ncnt = ti.cast(neighbor_counts[i], ti.i32)
            plant_neighbors = 0
            empty_neighbors = 0
            empties = ti.Vector([0] * 8, dt=ti.i32)
            for n in range(MAX_NEIGHBOR_COUNT):
                if n >= ncnt:
                    continue
                ni = neighbor_indices[base + n]
                if b_type[ni] == PLANT and b_biomass[ni] > 0:
                    plant_neighbors += 1
                if b_type[ni] == EMPTY:
                    empties[empty_neighbors] = ni
                    empty_neighbors += 1
            if empty_neighbors <= 0:
                continue
            if plant_neighbors < 1 or plant_neighbors > repro_neighbor_cap:
                continue

            # 选择一个“有合格 co-parent” 的空地：用最小随机 score 选
            best_e = ti.i32(-1)
            best_score = 2.0
            for k in range(8):
                if k >= empty_neighbors:
                    continue
                eidx = empties[k]
                # 检查该空地周围是否存在 eligible co-parent（不含自己）
                eb = eidx * MAX_NEIGHBOR_COUNT
                ecnt = ti.cast(neighbor_counts[eidx], ti.i32)
                has_cop = 0
                for n in range(MAX_NEIGHBOR_COUNT):
                    if n >= ecnt:
                        continue
                    ni = neighbor_indices[eb + n]
                    if ni == i:
                        continue
                    if b_type[ni] != PLANT:
                        continue
                    if b_biomass[ni] <= 0:
                        continue
                    if repro_eligible[ni] == 0:
                        continue
                    has_cop = 1
                if has_cop == 0:
                    continue
                score = self._rand01(tick_id, i, eidx, 1)
                if score < best_score:
                    best_score = score
                    best_e = eidx
            if best_e < 0:
                continue

            # 对空地 claim：选择最小 parent id 获胜（确定性冲突解决）
            ti.atomic_min(repro_claim[best_e], ti.cast(i, ti.i32))

    @ti.kernel
    def _phase3_repro_spawn(self,
                            b_type: ti.types.ndarray(dtype=ti.u8),
                            b_biomass: ti.types.ndarray(dtype=ti.f32),
                            b_energy: ti.types.ndarray(dtype=ti.f32),
                            b_gene: ti.types.ndarray(dtype=ti.f32),
                            b_age: ti.types.ndarray(dtype=ti.f32),
                            repro_eligible: ti.types.ndarray(dtype=ti.u8),
                            neighbor_indices: ti.types.ndarray(dtype=ti.i32),
                            neighbor_counts: ti.types.ndarray(dtype=ti.u8),
                            repro_claim: ti.types.ndarray(dtype=ti.i32),
                            tick_id: ti.i32,
                            child_biomass: ti.f32,
                            repro_energy_share_frac: ti.f32,
                            mutation_step: ti.f32,
                            mutation_distance_factor: ti.f32):
        PLANT = ti.u8(CellType.PLANT)
        EMPTY = ti.u8(CellType.EMPTY)
        sentinel = ti.i32(2147483647)

        for eidx in range(self.size):
            parent = repro_claim[eidx]
            if parent == sentinel:
                continue
            if b_type[eidx] != EMPTY:
                continue
            # parent 可能已死亡/被清理（极端情况下）
            if b_type[parent] != PLANT or b_biomass[parent] <= 0 or repro_eligible[parent] == 0:
                continue

            # 选择 co-parent（空地邻居中 eligible 的一个）：最小随机 score
            eb = eidx * MAX_NEIGHBOR_COUNT
            ecnt = ti.cast(neighbor_counts[eidx], ti.i32)
            best_cp = ti.i32(-1)
            best_score = 2.0
            for n in range(MAX_NEIGHBOR_COUNT):
                if n >= ecnt:
                    continue
                ni = neighbor_indices[eb + n]
                if ni == parent:
                    continue
                if b_type[ni] != PLANT:
                    continue
                if b_biomass[ni] <= 0:
                    continue
                if repro_eligible[ni] == 0:
                    continue
                score = self._rand01(tick_id, parent, ni, 2)
                if score < best_score:
                    best_score = score
                    best_cp = ni
            if best_cp < 0:
                continue

            # 能量转移
            p1e = b_energy[parent]
            p1share = p1e * repro_energy_share_frac
            p2e = ti.max(0.0, b_energy[best_cp])
            p2share = p2e * repro_energy_share_frac

            b_type[eidx] = PLANT
            b_biomass[eidx] = child_biomass
            b_energy[eidx] = p1share + p2share
            b_age[eidx] = 0.0
            repro_eligible[eidx] = 0

            # 基因继承 + 突变（fast hash RNG）
            g1 = b_gene[parent]
            g2 = b_gene[best_cp]
            pick = self._rand01(tick_id, parent, eidx, 3)
            parent_gene = g1 if pick < 0.5 else g2
            gene_diff = ti.abs(g1 - g2)
            step = mutation_step + gene_diff * mutation_distance_factor
            m = self._rand01(tick_id, parent, eidx, 4) * 2.0 - 1.0
            child_g = parent_gene + m * step
            if child_g < 0:
                child_g = 0.0
            elif child_g > 1:
                child_g = 1.0
            b_gene[eidx] = child_g

            # 扣除亲本能量（用 atomic_add 避免与其它写入冲突）
            ti.atomic_add(b_energy[parent], -p1share)
            ti.atomic_add(b_energy[best_cp], -p2share)

    @ti.kernel
    def _phase4_death_clear(self,
                            b_type: ti.types.ndarray(dtype=ti.u8),
                            b_biomass: ti.types.ndarray(dtype=ti.f32),
                            b_energy: ti.types.ndarray(dtype=ti.f32),
                            b_gene: ti.types.ndarray(dtype=ti.f32),
                            b_age: ti.types.ndarray(dtype=ti.f32)):
        PLANT = ti.u8(CellType.PLANT)
        EMPTY = ti.u8(CellType.EMPTY)
        for i in range(self.size):
            if b_type[i] != PLANT:
                continue
            if b_biomass[i] > 0:
                continue
            b_type[i] = EMPTY
            b_energy[i] = 0.0
            b_biomass[i] = 0.0
            b_gene[i] = 0.0
            b_age[i] = 0.0


def tick_fast(world: WorldTI, ticker: FastTicker):
    """执行一个 fast tick（性能档，含繁殖；随机序列不与 strict 对齐）"""
    cfg = world.config
    world.tick += 1
    world.time += cfg.timeStep
    polar = bool(cfg.polarDay)
    raw_sun = 1.0 if polar else math.sin(world.time * cfg.sunSpeed)
    sunlight = raw_sun if raw_sun > 0 else 0.0
    world.sunlight = sunlight
    day_step = 0.0 if polar else (cfg.timeStep * cfg.sunSpeed) / (math.pi * 2)
    world.day = (world.day if math.isfinite(world.day) else 0.0) + day_step

    # 预计算扩散比例
    norm = cfg.diffuseSelf + cfg.diffuseNeighbor
    out_frac = (cfg.diffuseNeighbor / norm) if norm > 0 else 0.0
    onorm = cfg.osmosisSelf + cfg.osmosisNeighbor
    osmosis_out_frac = (cfg.osmosisNeighbor / onorm) if onorm > 0 else 0.0
    overflow_share_frac = max(0.0, min(1.0, cfg.overflowShareFrac))

    a = world.front
    b = world.back
    s = world.scratch

    ticker._init_write_buffer(
        a.type, a.biomass, a.gene, a.age,
        b.type, b.biomass, b.gene, b.age,
        b.energy,
        s.repro_eligible
    )
    ticker._phase1_diffusion(
        a.type, a.biomass, a.energy, a.gene,
        b.energy,
        world.neighbors.indices, world.neighbors.counts,
        cfg.diffuseGradientThreshold, cfg.diffuseGradientScale, out_frac,
        osmosis_out_frac, cfg.osmosisGradientThreshold, cfg.osmosisGradientScale,
        cfg.energyMaxBase, cfg.energyMaxGeneRange
    )
    ticker._phase2_income_cost_cap(
        a.type, a.biomass, a.energy, a.gene, a.age,
        b.type, b.biomass, b.energy, b.gene, b.age,
        world.terrain.light, world.terrain.loss,
        world.neighbors.indices, world.neighbors.counts,
        day_step, sunlight,
        cfg.baseCost, cfg.geneCostFactor,
        cfg.isolationEnergyLoss, cfg.isolationZeroNeighborMultiplier,
        cfg.isolationGeneBase, cfg.isolationGeneFactor, int(cfg.isolationNeighborMin),
        int(cfg.crowdNeighborSoft), cfg.crowdEnergyLoss,
        int(cfg.reproNeighborCap),
        cfg.energyMaxBase, cfg.energyMaxGeneRange,
        cfg.ageMaxBase, cfg.ageMaxGeneRange,
        cfg.senescenceStartFrac, cfg.senescenceCostExtraMultiplier,
        cfg.photoIncomeBase, cfg.photoIncomeGeneFactor,
        s.overflow_out, s.overflow_in
    )
    if overflow_share_frac > 0:
        ticker._phase25_overflow_share(
            a.type, a.biomass,
            b.energy, b.gene,
            world.neighbors.indices, world.neighbors.counts,
            s.overflow_out, s.overflow_in,
            overflow_share_frac,
            cfg.energyMaxBase, cfg.energyMaxGeneRange
        )
    ticker._phase28_apply_overflow_biomass(
        a.type,
        b.type, b.biomass, b.energy, b.gene, b.age,
        s.overflow_in, s.repro_eligible,
        cfg.growthEnergyThreshold, cfg.growthRate, cfg.decayRate,
        cfg.reproBiomassRatio, cfg.reproEnergyRatio,
        cfg.energyMaxBase, cfg.energyMaxGeneRange,
        cfg.biomassMaxBase, cfg.biomassMaxGeneRange,
        cfg.ageMaxBase, cfg.ageMaxGeneRange,
        cfg.senescenceStartFrac
    )
    # Phase3 reproduction（fast）
    ticker._phase3_repro_claim(
        b.type, b.biomass, b.energy, b.gene, b.age,
        s.repro_eligible,
        world.neighbors.indices, world.neighbors.counts,
        s.repro_claim,
        int(world.tick),
        int(cfg.reproNeighborCap),
        cfg.energyMaxBase, cfg.energyMaxGeneRange,
        cfg.biomassMaxBase, cfg.biomassMaxGeneRange,
        cfg.reproBiomassRatio, cfg.reproEnergyRatio,
        cfg.ageMaxBase, cfg.ageMaxGeneRange,
        cfg.senescenceStartFrac
    )
    ticker._phase3_repro_spawn(
        b.type, b.biomass, b.energy, b.gene, b.age,
        s.repro_eligible,
        world.neighbors.indices, world.neighbors.counts,
        s.repro_claim,
        int(world.tick),
        cfg.childBiomass,
        cfg.reproEnergyShareFrac,
        cfg.mutationStep,
        cfg.mutationDistanceFactor
    )
    ticker._phase4_death_clear(b.type, b.biomass, b.energy, b.gene, b.age)

    world.swap_buffers()


def get_stats_fast(world: WorldTI):
    """低频获取统计（viewer 用）

    备注：Taichi 1.7.x 对 template/field 作为 kernel 参数的限制较多，
    这里先用 to_numpy 做低频统计（后续可再做专用 reduction kernel）。
    """
    t = world.front.type.to_numpy()
    bio = world.front.biomass.to_numpy()
    gene = world.front.gene.to_numpy()
    plant_mask = (t == int(CellType.PLANT))
    pc = int(plant_mask.sum())
    total_b = float(bio[plant_mask].sum()) if pc else 0.0
    gene_sum = float(gene[plant_mask].sum()) if pc else 0.0
    return {
        "plant_count": pc,
        "total_biomass": total_b,
        "avg_gene": (gene_sum / pc) if pc > 0 else 0.0,
    }

