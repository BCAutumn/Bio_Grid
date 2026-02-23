export function createSnapshotPublisher({ state, computeStats, postMessage, controlWriteSlot, controlVersion }) {
  function updateSnapshotInterval() {
    // “能量传输视图”需要更低刷新频率，避免高 tick/s 时屏闪与大量数据传输
    const base = state.render.viewMode === 'transfer' ? 120 : 15;
    state.snapshotIntervalMs = state.render.mode === 'worker' ? 120 : base;
  }

  function snapshotStats(world) {
    const stats = computeStats(world);
    const day = Number.isFinite(world.day) ? world.day : 0;
    return {
      day,
      stats: {
        tick: stats.tick,
        totalBiomass: stats.totalBiomass,
        avgGene: stats.avgGene,
        plantCount: stats.plantCount
      }
    };
  }

  function shouldSkip(force) {
    const now = performance.now();
    if (!force && now - state.lastSnapshotTs < state.snapshotIntervalMs) return true;
    state.lastSnapshotTs = now;
    return false;
  }

  function publishSharedSnapshot(force = false) {
    const world = state.world;
    const shared = state.shared;
    if (!world || !shared || shouldSkip(force)) return;
    const { day, stats } = snapshotStats(world);
    const currentSlot = Atomics.load(shared.control, controlWriteSlot);
    const nextSlot = currentSlot ^ 1;
    const slot = shared.slots[nextSlot];
    slot.biomass.set(world.front.biomass);
    slot.energy.set(world.front.energy);
    slot.gene.set(world.front.gene);
    slot.cellType.set(world.front.type);
    if (slot.flowIn && world.flow?.in) slot.flowIn.set(world.flow.in);
    if (slot.flowOut && world.flow?.out) slot.flowOut.set(world.flow.out);
    if (slot.flowVx && world.flow?.vx) slot.flowVx.set(world.flow.vx);
    if (slot.flowVy && world.flow?.vy) slot.flowVy.set(world.flow.vy);
    Atomics.store(shared.control, controlWriteSlot, nextSlot);
    const version = Atomics.add(shared.control, controlVersion, 1) + 1;

    postMessage({
      type: 'snapshotMeta',
      version,
      time: world.time,
      day,
      sunlight: world.sunlight,
      stats
    });
  }

  function publishTransferSnapshot(force = false) {
    const world = state.world;
    if (!world || shouldSkip(force)) return;
    const { day, stats } = snapshotStats(world);
    const biomass = world.front.biomass.slice();
    const energy = world.front.energy.slice();
    const gene = world.front.gene.slice();
    const age = world.front.age.slice();
    const cellType = world.front.type.slice();
    const includeFlow = state.render?.viewMode === 'transfer';
    const flowIn = includeFlow && world.flow?.in ? world.flow.in.slice() : null;
    const flowOut = includeFlow && world.flow?.out ? world.flow.out.slice() : null;
    const flowVx = includeFlow && world.flow?.vx ? world.flow.vx.slice() : null;
    const flowVy = includeFlow && world.flow?.vy ? world.flow.vy.slice() : null;

    const message = {
      type: 'snapshot',
      time: world.time,
      day,
      sunlight: world.sunlight,
      stats,
      biomass: biomass.buffer,
      energy: energy.buffer,
      gene: gene.buffer,
      age: age.buffer,
      cellType: cellType.buffer
    };
    const transfers = [biomass.buffer, energy.buffer, gene.buffer, age.buffer, cellType.buffer];
    if (flowIn) { message.flowIn = flowIn.buffer; transfers.push(flowIn.buffer); }
    if (flowOut) { message.flowOut = flowOut.buffer; transfers.push(flowOut.buffer); }
    if (flowVx) { message.flowVx = flowVx.buffer; transfers.push(flowVx.buffer); }
    if (flowVy) { message.flowVy = flowVy.buffer; transfers.push(flowVy.buffer); }
    postMessage(message, transfers);
  }

  function publishMetaOnly(force = false) {
    const world = state.world;
    if (!world || shouldSkip(force)) return;
    const { day, stats } = snapshotStats(world);
    postMessage({
      type: 'snapshotMeta',
      time: world.time,
      day,
      sunlight: world.sunlight,
      stats
    });
  }

  function postSnapshot(force = false) {
    if (state.useShared) publishSharedSnapshot(force);
    else if (state.render.mode === 'worker') publishMetaOnly(force);
    else publishTransferSnapshot(force);
  }

  function initSharedChannels(sharedSpec, size) {
    if (!sharedSpec || typeof SharedArrayBuffer === 'undefined') return false;
    const control = new Int32Array(sharedSpec.control);
    const biomassAll = new Float32Array(sharedSpec.biomass);
    const energyAll = new Float32Array(sharedSpec.energy);
    const geneAll = new Float32Array(sharedSpec.gene);
    const typeAll = new Uint8Array(sharedSpec.cellType);
    const flowInAll = sharedSpec.flowIn ? new Float32Array(sharedSpec.flowIn) : null;
    const flowOutAll = sharedSpec.flowOut ? new Float32Array(sharedSpec.flowOut) : null;
    const flowVxAll = sharedSpec.flowVx ? new Float32Array(sharedSpec.flowVx) : null;
    const flowVyAll = sharedSpec.flowVy ? new Float32Array(sharedSpec.flowVy) : null;
    const offset = size;

    state.shared = {
      control,
      slots: [
        {
          biomass: biomassAll.subarray(0, offset),
          energy: energyAll.subarray(0, offset),
          gene: geneAll.subarray(0, offset),
          cellType: typeAll.subarray(0, offset),
          flowIn: flowInAll ? flowInAll.subarray(0, offset) : null,
          flowOut: flowOutAll ? flowOutAll.subarray(0, offset) : null,
          flowVx: flowVxAll ? flowVxAll.subarray(0, offset) : null,
          flowVy: flowVyAll ? flowVyAll.subarray(0, offset) : null
        },
        {
          biomass: biomassAll.subarray(offset, offset * 2),
          energy: energyAll.subarray(offset, offset * 2),
          gene: geneAll.subarray(offset, offset * 2),
          cellType: typeAll.subarray(offset, offset * 2),
          flowIn: flowInAll ? flowInAll.subarray(offset, offset * 2) : null,
          flowOut: flowOutAll ? flowOutAll.subarray(offset, offset * 2) : null,
          flowVx: flowVxAll ? flowVxAll.subarray(offset, offset * 2) : null,
          flowVy: flowVyAll ? flowVyAll.subarray(offset, offset * 2) : null
        }
      ]
    };

    Atomics.store(control, controlWriteSlot, 0);
    Atomics.store(control, controlVersion, 0);
    state.useShared = true;
    return true;
  }

  return { updateSnapshotInterval, postSnapshot, initSharedChannels };
}
