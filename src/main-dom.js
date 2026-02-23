export function getMainDom() {
  const simCanvas = document.getElementById('simCanvas');
  const chartCanvas = document.getElementById('chartCanvas');
  const skyOrbit = document.getElementById('skyOrbit');
  const orbit = document.querySelector('.orbit');

  const panel = {
    time: document.getElementById('statTime'),
    sunlight: document.getElementById('statSunlight'),
    biomass: document.getElementById('statBiomass'),
    plants: document.getElementById('statPlants'),
    gene: document.getElementById('statGene'),
    hint: document.getElementById('toolHint')
  };

  const buttons = {
    btnPause: document.getElementById('btnPause'),
    btnReset: document.getElementById('btnReset'),
    btnSeed: document.getElementById('btnSeed'),
    btnViewReset: document.getElementById('btnViewReset'),
    btnCellValues: document.getElementById('btnCellValues'),
    btnAgingGlow: document.getElementById('btnAgingGlow'),
    btnModeLife: document.getElementById('btnModeLife'),
    btnModeDisturb: document.getElementById('btnModeDisturb'),
    btnModeAnnihilate: document.getElementById('btnModeAnnihilate'),
    btnModeWall: document.getElementById('btnModeWall'),
    btnModeErase: document.getElementById('btnModeErase'),
    btnModeLightUp: document.getElementById('btnModeLightUp'),
    btnModeLightDown: document.getElementById('btnModeLightDown'),
    btnModeLossUp: document.getElementById('btnModeLossUp'),
    btnModeLossDown: document.getElementById('btnModeLossDown'),
    btnShapeCircle: document.getElementById('btnShapeCircle'),
    btnShapeSquare: document.getElementById('btnShapeSquare'),
    btnShapeRect: document.getElementById('btnShapeRect'),
    btnShapeTriangle: document.getElementById('btnShapeTriangle'),
    btnPresetEmpty: document.getElementById('btnPresetEmpty'),
    btnPresetFourRooms: document.getElementById('btnPresetFourRooms'),
    btnPresetMaze: document.getElementById('btnPresetMaze'),
    btnPresetFiveZones: document.getElementById('btnPresetFiveZones'),
    btnPresetHourglass: document.getElementById('btnPresetHourglass'),
    btnPresetRings: document.getElementById('btnPresetRings'),
    btnViewEco: document.getElementById('btnViewEco'),
    btnViewTerrainLight: document.getElementById('btnViewTerrainLight'),
    btnViewTerrainLoss: document.getElementById('btnViewTerrainLoss'),
    btnViewTerrainMix: document.getElementById('btnViewTerrainMix'),
    btnMapUndo: document.getElementById('btnMapUndo'),
    btnMapRedo: document.getElementById('btnMapRedo'),
    btnTerrainUniformReset: document.getElementById('btnTerrainUniformReset')
  };

  const inputs = {
    speedInput: document.getElementById('speedRange'),
    speedValue: document.getElementById('speedValue'),
    radiusInput: document.getElementById('radiusRange'),
    radiusInputMap: document.getElementById('radiusRangeMap'),
    geneInput: document.getElementById('geneRange'),
    radiusValue: document.getElementById('radiusValue'),
    radiusValueMap: document.getElementById('radiusValueMap'),
    geneValue: document.getElementById('geneValue'),
    sunSpeedInput: document.getElementById('sunSpeedRange'),
    sunSpeedValue: document.getElementById('sunSpeedValue'),
    zoomInput: document.getElementById('zoomRange'),
    zoomValue: document.getElementById('zoomValue'),
    terrainStrengthInput: document.getElementById('terrainStrengthRange'),
    terrainStrengthValue: document.getElementById('terrainStrengthValue')
  };

  const tabs = {
    tabControls: document.getElementById('tabControls'),
    tabMapEditor: document.getElementById('tabMapEditor'),
    tabStats: document.getElementById('tabStats'),
    contentControls: document.getElementById('contentControls'),
    contentMapEditor: document.getElementById('contentMapEditor'),
    panelStats: document.querySelector('.panel-stats')
  };

  return { simCanvas, chartCanvas, skyOrbit, orbit, panel, buttons, inputs, tabs };
}
