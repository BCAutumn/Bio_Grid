const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const GENE_LUT_SIZE = 256;
const SAT_LUT_SIZE = 64;
const SAT_E_MAX = 40;
const HSV_COEFF_LUT = new Float32Array(GENE_LUT_SIZE * SAT_LUT_SIZE * 3);

function hsvToRgb(h, s, v) {
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const c = val * sat;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = val - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

for (let gi = 0; gi < GENE_LUT_SIZE; gi++) {
  const g = gi / (GENE_LUT_SIZE - 1);
  const hue = 200 - g * 180;
  for (let si = 0; si < SAT_LUT_SIZE; si++) {
    const e = (si / (SAT_LUT_SIZE - 1)) * SAT_E_MAX;
    const sat = clamp((20 + Math.log1p(e) * 18) / 100, 0.08, 1);
    const [r, gg, b] = hsvToRgb(hue, sat, 1);
    const o = (gi * SAT_LUT_SIZE + si) * 3;
    HSV_COEFF_LUT[o] = r / 255;
    HSV_COEFF_LUT[o + 1] = gg / 255;
    HSV_COEFF_LUT[o + 2] = b / 255;
  }
}

export function paintWorldToPixels(world, pixels, options = {}) {
  const { type, biomass, energy, gene, age } = world.front;
  const showAgingGlow = !!options.showAgingGlow;
  for (let i = 0; i < world.size; i++) {
    const offset = i * 4;
    const t = type[i];
    if (t === 3) {
      pixels[offset] = 210;
      pixels[offset + 1] = 215;
      pixels[offset + 2] = 220;
      pixels[offset + 3] = 255;
      continue;
    }

    const g = clamp(gene[i], 0, 1);
    const e = Math.max(0, energy[i]);
    const gIdx = (g * (GENE_LUT_SIZE - 1)) | 0;
    const eIdx = Math.min(SAT_LUT_SIZE - 1, ((e / SAT_E_MAX) * (SAT_LUT_SIZE - 1)) | 0);
    const lutOffset = (gIdx * SAT_LUT_SIZE + eIdx) * 3;
    const value = t === 1 ? clamp((biomass[i] * 90 + Math.min(12, e * 0.25)) / 100, 0, 1) : clamp((e * 0.08) / 100, 0, 0.18);
    const scale = value * 255;
    let r = HSV_COEFF_LUT[lutOffset] * scale;
    let gg = HSV_COEFF_LUT[lutOffset + 1] * scale;
    let b = HSV_COEFF_LUT[lutOffset + 2] * scale;
    if (showAgingGlow && t === 1 && biomass[i] > 0 && age && age[i] > 0) {
      const cellMaxAge = 3 + (1 - g) * 1.5;
      const senescenceFactor = (age[i] - cellMaxAge * 0.7) / (cellMaxAge * 0.3);
      if (senescenceFactor > 0) {
        const glow = Math.min(1, senescenceFactor) * 0.85;
        r = Math.min(255, r + (255 - r) * glow);
        gg *= 1 - glow;
        b *= 1 - glow;
      }
    }
    pixels[offset] = r;
    pixels[offset + 1] = gg;
    pixels[offset + 2] = b;
    pixels[offset + 3] = 255;
  }
}

export function updateSkyBadge(world, orbitEl, timeOverride = null) {
  if (!orbitEl) return;
  const time = timeOverride == null ? world.time : timeOverride;
  const cycle = (time * world.config.sunSpeed) % (Math.PI * 2);
  const sun = Math.max(0, Math.sin(cycle));
  orbitEl.style.setProperty('--sun', sun.toFixed(4));

  if (cycle < Math.PI) {
    const t = cycle / Math.PI;
    const x = t * 100;
    const y = 95 - Math.sin(cycle) * 70;
    orbitEl.style.setProperty('--sun-x', x.toFixed(2));
    orbitEl.style.setProperty('--sun-y', y.toFixed(2));
    orbitEl.style.setProperty('--sun-a', '1');
    orbitEl.style.setProperty('--moon-a', '0');
  } else {
    const t = (cycle - Math.PI) / Math.PI;
    const x = t * 100;
    const y = 95 - Math.sin(cycle - Math.PI) * 70;
    orbitEl.style.setProperty('--moon-x', x.toFixed(2));
    orbitEl.style.setProperty('--moon-y', y.toFixed(2));
    orbitEl.style.setProperty('--moon-a', '1');
    orbitEl.style.setProperty('--sun-a', '0');
  }
}

export function drawChart(ctx, w, h, biomassHistory, geneHistory) {
  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, 'rgba(10, 10, 10, 0.95)');
  bg.addColorStop(1, 'rgba(18, 18, 18, 0.95)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.moveTo(28, h - 18);
  ctx.lineTo(w - 8, h - 18);
  ctx.moveTo(28, h - 18);
  ctx.lineTo(28, 8);
  ctx.stroke();

  const drawSeries = (values, color, min, max) => {
    if (!values.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = 28 + (i / (values.length - 1 || 1)) * (w - 36);
      const n = clamp((values[i] - min) / (max - min || 1), 0, 1);
      const y = h - 18 - n * (h - 30);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  drawSeries(biomassHistory, '#f87171', 0, 1);
  drawSeries(geneHistory, '#38bdf8', 0, 1);
  ctx.fillStyle = 'rgba(243, 244, 246, 0.8)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.fillText('Biomass', 36, 18);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('Avg Gene', 90, 18);
}

export function drawCellValuesOverlay(ctx, world, view, canvasW, canvasH) {
  const startX = Math.max(0, Math.floor(view.sx));
  const endX = Math.min(world.width - 1, Math.ceil(view.sx + view.sw) - 1);
  const startY = Math.max(0, Math.floor(view.sy));
  const endY = Math.min(world.height - 1, Math.ceil(view.sy + view.sh) - 1);
  const cellW = canvasW / view.sw;
  const cellH = canvasH / view.sh;
  const textSize = Math.max(9, Math.min(18, Math.floor(Math.min(cellW, cellH) * 0.25)));
  const pad = Math.max(2, Math.floor(Math.min(cellW, cellH) * 0.1));
  const { biomass, energy } = world.front;
  const maxEnergy = world.config.maxEnergy || 1;

  ctx.save();
  ctx.font = `${textSize}px system-ui, -apple-system, sans-serif`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 2;
  for (let y = startY; y <= endY; y++) for (let x = startX; x <= endX; x++) {
    const i = y * world.width + x;
    const px = (x - view.sx) * cellW;
    const py = (y - view.sy) * cellH;
    const bio = biomass[i].toFixed(2);
    const en = clamp(energy[i], 0, maxEnergy).toFixed(1);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(246, 251, 255, 0.95)';
    ctx.fillText(bio, px + pad, py + pad);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(90, 211, 255, 0.95)';
    ctx.fillText(en, px + cellW - pad, py + cellH - pad);
  }
  ctx.restore();
}
