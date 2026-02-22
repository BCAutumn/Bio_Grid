// test_battery.js
const ticks = 2094;
const avgSun = 0.6366;
const maxEnergy = 36;

function simulate(gene, neighbors) {
    const baseCost = 0.002;
    const geneCostFactor = 0.006;
    const isolation = 0.016;
    const crowd = 0.002;
    
    let crowdPenalty = 0;
    if (neighbors > 5) {
        crowdPenalty = Math.pow(neighbors - 5, 2) * crowd;
    }
    let isoPenalty = 0;
    if (neighbors < 2) {
        isoPenalty = isolation;
    }
    
    const cost = baseCost + gene * gene * geneCostFactor + crowdPenalty + isoPenalty;
    const income = (0.02 + gene * 0.05);
    const dayIncome = income * avgSun * ticks;
    const dayCost = cost * ticks;
    const nightCost = cost * ticks;
    
    let energy = 24;
    console.log(`--- Gene: ${gene}, Neighbors: ${neighbors} ---`);
    console.log(`Cost/tick: ${cost.toFixed(5)}, Day Net: ${(dayIncome - dayCost).toFixed(1)}, Night Cost: ${nightCost.toFixed(1)}`);
    
    // Day 1
    let gained = dayIncome - dayCost;
    energy = Math.min(maxEnergy, energy + gained);
    console.log(`End of Day 1: ${energy.toFixed(1)}`);
    // Night 1
    energy -= nightCost;
    console.log(`End of Night 1: ${energy.toFixed(1)} ${energy < 0 ? '(DIES)' : '(SURVIVES)'}`);
    
    // Day 2
    if (energy > 0) {
        energy = Math.min(maxEnergy, energy + gained);
        console.log(`End of Day 2: ${energy.toFixed(1)}`);
        energy -= nightCost;
        console.log(`End of Night 2: ${energy.toFixed(1)} ${energy < 0 ? '(DIES)' : '(SURVIVES)'}`);
    }
}

simulate(0, 0);   // Isolated conservative
simulate(1, 0);   // Isolated radical
simulate(0.5, 4); // Healthy intermediate
simulate(0.5, 7); // Very crowded
simulate(0.5, 8); // Max crowded
