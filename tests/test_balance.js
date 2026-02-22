// test_balance.js
import { DEFAULT_CONFIG } from '../src/config.js';

const ticks = 2094;
const avgSun = 0.6366;
const maxEnergy = DEFAULT_CONFIG.maxEnergy;
const crowdSoft = DEFAULT_CONFIG.crowdNeighborSoft;

function simulate(gene, neighbors) {
    const baseCost = DEFAULT_CONFIG.baseCost;
    const geneCostFactor = DEFAULT_CONFIG.geneCostFactor;
    const isolation = DEFAULT_CONFIG.isolationEnergyLoss;
    const isolationZeroNeighborMultiplier = DEFAULT_CONFIG.isolationZeroNeighborMultiplier ?? 2;
    const isolationGeneBase = DEFAULT_CONFIG.isolationGeneBase ?? 1;
    const isolationGeneFactor = DEFAULT_CONFIG.isolationGeneFactor ?? 0;
    const crowd = DEFAULT_CONFIG.crowdEnergyLoss;
    
    let crowdPenalty = 0;
    if (neighbors > crowdSoft) {
        const localCrowd = neighbors - crowdSoft;
        const crowdFactor = localCrowd === 1 ? 1 : localCrowd === 2 ? 2 : localCrowd === 3 ? 6 : 15;
        crowdPenalty = crowdFactor * crowd;
    }
    let isoPenalty = 0;
    if (neighbors < 2) {
        const neighborFactor = neighbors === 0 ? isolationZeroNeighborMultiplier : 1;
        const geneFactor = isolationGeneBase + gene * isolationGeneFactor;
        isoPenalty = isolation * neighborFactor * geneFactor;
    }
    
    const cost = baseCost + gene * gene * geneCostFactor + crowdPenalty + isoPenalty;
    const income = (0.02 + gene * 0.064);
    const dayIncome = income * avgSun * ticks;
    const dayCost = cost * ticks;
    const nightCost = cost * ticks;
    
    let energy = 24;
    console.log(`--- Gene: ${gene}, Neighbors: ${neighbors} ---`);
    console.log(`Cost/tick: ${cost.toFixed(5)}, Income/tick(peak): ${income.toFixed(5)}`);
    
    // Day
    let gained = dayIncome - dayCost;
    energy = Math.min(maxEnergy, energy + gained);
    console.log(`End of Day 1 Energy: ${energy.toFixed(1)}`);
    
    // Night
    energy -= nightCost;
    console.log(`End of Night 1 Energy: ${energy.toFixed(1)} ${energy < 0 ? '(DIES)' : '(SURVIVES)'}`);
    
    // Day 2
    if (energy > 0) {
        energy = Math.min(maxEnergy, energy + gained);
        console.log(`End of Day 2 Energy: ${energy.toFixed(1)}`);
        energy -= nightCost;
        console.log(`End of Night 2 Energy: ${energy.toFixed(1)} ${energy < 0 ? '(DIES)' : '(SURVIVES)'}`);
    }
}

simulate(0, 0);   // Isolated conservative
simulate(1, 0);   // Isolated radical
simulate(0.5, 4); // Healthy intermediate
simulate(0.5, 6); // Slightly crowded
simulate(0.5, 7); // Very crowded
simulate(0.5, 8); // Max crowded
