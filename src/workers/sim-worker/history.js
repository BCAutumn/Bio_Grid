export function createTerrainHistoryController({ state, postMessage, postSnapshot, renderFrame }) {
  function cloneWorldState(world) {
    return {
      front: {
        biomass: world.front.biomass.slice(),
        energy: world.front.energy.slice(),
        gene: world.front.gene.slice(),
        age: world.front.age.slice(),
        type: world.front.type.slice()
      },
      back: {
        biomass: world.back.biomass.slice(),
        energy: world.back.energy.slice(),
        gene: world.back.gene.slice(),
        age: world.back.age.slice(),
        type: world.back.type.slice()
      },
      time: world.time,
      sunlight: world.sunlight,
      stats: { ...world.stats },
      wallCount: world.wallCount
    };
  }

  function restoreWorldState(world, snapshot) {
    if (!world || !snapshot) return;
    world.front.biomass.set(snapshot.front.biomass);
    world.front.energy.set(snapshot.front.energy);
    world.front.gene.set(snapshot.front.gene);
    world.front.age.set(snapshot.front.age);
    world.front.type.set(snapshot.front.type);
    world.back.biomass.set(snapshot.back.biomass);
    world.back.energy.set(snapshot.back.energy);
    world.back.gene.set(snapshot.back.gene);
    world.back.age.set(snapshot.back.age);
    world.back.type.set(snapshot.back.type);
    world.time = snapshot.time;
    world.sunlight = snapshot.sunlight;
    world.stats.tick = snapshot.stats.tick;
    world.stats.totalBiomass = snapshot.stats.totalBiomass;
    world.stats.avgGene = snapshot.stats.avgGene;
    world.stats.plantCount = snapshot.stats.plantCount;
    world.stats.normalizedBiomass = snapshot.stats.normalizedBiomass ?? 0;
    world.stats.senescentRatio = snapshot.stats.senescentRatio ?? 0;
    world.wallCount = snapshot.wallCount;
  }

  function postState(action = 'sync') {
    postMessage({
      type: 'terrainHistoryState',
      action,
      canUndo: state.terrainHistory.undo.length > 0,
      canRedo: state.terrainHistory.redo.length > 0
    });
  }

  function push(clearRedo = true) {
    if (!state.world) return;
    const { undo, redo, limit } = state.terrainHistory;
    undo.push(cloneWorldState(state.world));
    if (undo.length > limit) undo.shift();
    if (clearRedo) redo.length = 0;
    postState('push');
  }

  function undo() {
    if (!state.world) return;
    const { undo, redo } = state.terrainHistory;
    if (!undo.length) {
      postState('undo-empty');
      return;
    }
    const current = cloneWorldState(state.world);
    const prev = undo.pop();
    redo.push(current);
    restoreWorldState(state.world, prev);
    state.accumulator = 0;
    postSnapshot(true);
    renderFrame(true);
    postState('undo');
  }

  function redo() {
    if (!state.world) return;
    const { undo, redo } = state.terrainHistory;
    if (!redo.length) {
      postState('redo-empty');
      return;
    }
    const current = cloneWorldState(state.world);
    const next = redo.pop();
    undo.push(current);
    restoreWorldState(state.world, next);
    state.accumulator = 0;
    postSnapshot(true);
    renderFrame(true);
    postState('redo');
  }

  function resetStacks() {
    state.terrainHistory.undo.length = 0;
    state.terrainHistory.redo.length = 0;
  }

  return { postState, push, undo, redo, resetStacks };
}
