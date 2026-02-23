const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const normalize = (v, min, max) => {
  const span = max - min;
  if (span <= 0) return 0;
  return clamp((v - min) / span, 0, 1);
};
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
  const viewMode = options.viewMode || 'eco';
  const terrain = world.terrain;
  const terrainLight = terrain?.light;
  const terrainLoss = terrain?.loss;
  const lightMin = terrain?.lightMin ?? 1;
  const lightMax = terrain?.lightMax ?? 1;
  const lossMin = terrain?.lossMin ?? 1;
  const lossMax = terrain?.lossMax ?? 1;

  for (let i = 0; i < world.size; i++) {
    const offset = i * 4;
    const t = type[i];
    const lightFactor = terrainLight ? terrainLight[i] : 1;
    const lossFactor = terrainLoss ? terrainLoss[i] : 1;
    const lightNorm = normalize(lightFactor, lightMin, lightMax);
    const lossNorm = normalize(lossFactor, lossMin, lossMax);

    if (t === 3) {
      pixels[offset] = 210;
      pixels[offset + 1] = 215;
      pixels[offset + 2] = 220;
      pixels[offset + 3] = 255;
      continue;
    }

    if (viewMode === 'terrainLight') {
      const v = 28 + lightNorm * 210;
      // 金黄色光照热力图：低值偏棕，高值偏亮金，便于直观看“光照富集区”。
      pixels[offset] = 28 + v * 1.05;
      pixels[offset + 1] = 20 + v * 0.78;
      pixels[offset + 2] = 6 + v * 0.18;
      pixels[offset + 3] = 255;
      continue;
    }

    if (viewMode === 'terrainLoss') {
      pixels[offset] = 35 + lossNorm * 210;
      pixels[offset + 1] = 145 - lossNorm * 90;
      pixels[offset + 2] = 215 - lossNorm * 185;
      pixels[offset + 3] = 255;
      continue;
    }

    if (viewMode === 'terrainMix') {
      // 高对比复合地形：R 表示流失，G/B 表示光照，便于快速看出“高光高耗/低光低耗”等组合。
      pixels[offset] = 40 + lossNorm * 210;
      pixels[offset + 1] = 30 + lightNorm * 210;
      pixels[offset + 2] = 30 + (1 - lossNorm) * 60 + lightNorm * 150;
      pixels[offset + 3] = 255;
      continue;
    }

    if (t === 0) {
      let r = 5 + lightNorm * 14 + lossNorm * 14;
      let gg = 8 + lightNorm * 21 - lossNorm * 5;
      let b = 12 + lightNorm * 28 - lossNorm * 10;
      const e = energy[i];
      if (e > 0) {
        const eIdx = Math.min(SAT_LUT_SIZE - 1, ((e / SAT_E_MAX) * (SAT_LUT_SIZE - 1)) | 0);
        const lutOffset = eIdx * 3; // gIdx is 0
        const value = Math.min(0.18, e * 0.0008);
        const scale = value * 255;
        r += HSV_COEFF_LUT[lutOffset] * scale;
        gg += HSV_COEFF_LUT[lutOffset + 1] * scale;
        b += HSV_COEFF_LUT[lutOffset + 2] * scale;
      }
      pixels[offset] = clamp(r, 0, 255);
      pixels[offset + 1] = clamp(gg, 0, 255);
      pixels[offset + 2] = clamp(b, 0, 255);
      pixels[offset + 3] = 255;
      continue;
    }

    const eRaw = energy[i];
    const e = eRaw > 0 ? eRaw : 0;
    const g = gene[i];
    const gIdx = (g * 255) | 0; // GENE_LUT_SIZE - 1 = 255
    const eIdx = e < 40 ? ((e / 40) * 63) | 0 : 63; // SAT_E_MAX = 40, SAT_LUT_SIZE - 1 = 63
    const lutOffset = (gIdx * 64 + eIdx) * 3; // SAT_LUT_SIZE = 64
    const value = t === 1 ? Math.min(1, biomass[i] * 0.9 + Math.min(0.12, e * 0.0025)) : Math.min(0.18, e * 0.0008);
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

export function updateSkyBadge(orbitEl, simTime, sunSpeed) {
  if (!orbitEl) return;
  const speed = Number.isFinite(sunSpeed) ? sunSpeed : 0;
  const t = Number.isFinite(simTime) ? simTime : 0;
  const phase = (t * speed) % (Math.PI * 2);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const sunlight = s > 0 ? s : 0;

  // Sun arc: x follows cos, y follows sin (above horizon when s>0)
  const sunX = 50 - c * 46;
  const sunY = 84 - s * 68;
  const sunA = s > 0 ? 1 : 0;

  // Moon: opposite phase
  const ms = Math.sin(phase + Math.PI);
  const mc = Math.cos(phase + Math.PI);
  const moonX = 50 - mc * 46;
  const moonY = 84 - ms * 68;
  const moonA = s <= 0 ? 1 : 0;

  orbitEl.style.setProperty('--sun', String(sunlight));
  orbitEl.style.setProperty('--sun-x', String(sunX));
  orbitEl.style.setProperty('--sun-y', String(sunY));
  orbitEl.style.setProperty('--sun-a', String(sunA));
  orbitEl.style.setProperty('--moon-x', String(moonX));
  orbitEl.style.setProperty('--moon-y', String(moonY));
  orbitEl.style.setProperty('--moon-a', String(moonA));
}
