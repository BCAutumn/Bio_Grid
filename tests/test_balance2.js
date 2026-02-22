// test_balance2.js
const ticks = 2094;
const avgSun = 0.6366;

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
    console.log(`Cost/tick: ${cost.toFixed(5)}, Income/tick(peak): ${income.toFixed(5)}`);
    
    // Day
    let gained = dayIncome - dayCost;
    energy = Math.min(36, energy + gained);
    console.log(`End of Day 1 Energy: ${energy.toFixed(1)}`);
    
    // Night
    energy -= nightCost;
    console.log(`End of Night 1 Energy: ${energy.toFixed(1)} ${energy < 0 ? '(DIES)' : '(SURVIVES)'}`);
}

simulate(0, 8);
simulate(0.2, 8);
simulate(1, 8);
simulate(0, 7);
simulate(1, 7);
