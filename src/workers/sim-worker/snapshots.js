export function createSnapshotPublisher({ state, computeStats, postMessage, controlWriteSlot, controlVersion }) {
  function updateSnapshotInterval() {
    state.snapshotIntervalMs = state.render.mode === 'worker' ? 80 : 15;
  }

  function snapshotStats(world) {
    const stats = computeStats(world);
    const day = (world.time * (world.config.sunSpeed || 0)) / (Math.PI * 2);
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

    postMessage({
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
    }, [biomass.buffer, energy.buffer, gene.buffer, age.buffer, cellType.buffer]);
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
    const offset = size;

    state.shared = {
      control,
      slots: [
        {
          biomass: biomassAll.subarray(0, offset),
          energy: energyAll.subarray(0, offset),
          gene: geneAll.subarray(0, offset),
          cellType: typeAll.subarray(0, offset)
        },
        {
          biomass: biomassAll.subarray(offset, offset * 2),
          energy: energyAll.subarray(offset, offset * 2),
          gene: geneAll.subarray(offset, offset * 2),
          cellType: typeAll.subarray(offset, offset * 2)
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
