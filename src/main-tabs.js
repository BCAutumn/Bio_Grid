export function bindSidebarTabs({ state, tabs, onStatsVisible, onMapTabEnter, onControlsTabEnter }) {
  const { tabControls, tabMapEditor, tabStats, contentControls, contentMapEditor, panelStats } = tabs;

  function updateTabs() {
    const compactMode = window.innerWidth <= 1600;
    if (!compactMode && state.activeSidebarTab === 'stats') state.activeSidebarTab = 'controls';
    const active = state.activeSidebarTab;
    const showControls = active === 'controls';
    const showMapEditor = active === 'map';
    const showStats = compactMode && active === 'stats';

    tabControls.classList.toggle('is-active', showControls);
    if (tabMapEditor) tabMapEditor.classList.toggle('is-active', showMapEditor);
    if (tabStats) tabStats.classList.toggle('is-active', showStats);

    contentControls.classList.toggle('is-active', showControls);
    if (contentMapEditor) contentMapEditor.classList.toggle('is-active', showMapEditor);
    if (compactMode) panelStats.classList.toggle('is-active', showStats);
    else panelStats.classList.remove('is-active');

    if (showStats || !compactMode) onStatsVisible();
  }

  tabControls.addEventListener('click', () => {
    state.activeSidebarTab = 'controls';
    if (typeof onControlsTabEnter === 'function') onControlsTabEnter();
    updateTabs();
  });

  if (tabMapEditor) {
    tabMapEditor.addEventListener('click', () => {
      state.activeSidebarTab = 'map';
      onMapTabEnter();
      updateTabs();
    });
  }

  if (tabStats) {
    tabStats.addEventListener('click', () => {
      state.activeSidebarTab = 'stats';
      updateTabs();
    });
  }

  window.addEventListener('resize', updateTabs);
  return { updateTabs };
}
