const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const normalize = (v, min, max) => {
  const span = max - min;
  if (span <= 0) return 0;
  return clamp((v - min) / span, 0, 1);
};
const PHASE_TAU = Math.PI * 2;
const phaseFromIndex = (i) => {
  // 用整数哈希生成稳定相位，避免 i%N 造成沿行索引的斜向条纹闪烁。
  let h = (i | 0) ^ 0x9e3779b9;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * PHASE_TAU;
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
  // gene=0 用中等偏深蓝（220deg）：比旧版更蓝，但不至于过深。
  const hue = 220 - g * 200;
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
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : (typeof performance !== 'undefined' ? performance.now() : 0);
  const flow = world.flow;
  const flowIn = flow?.in;
  const flowOut = flow?.out;
  const flowVx = flow?.vx;
  const flowVy = flow?.vy;
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

    if (viewMode === 'transfer') {
      // 能量传输视图：底色为暗地形，叠加“源/汇”闪烁高亮；方向箭头由 drawFlowOverlay 负责绘制。
      if (t === 0) {
        const base = 10 + lightNorm * 10 + (1 - lossNorm) * 6;
        pixels[offset] = base;
        pixels[offset + 1] = base;
        pixels[offset + 2] = base + 4;
        pixels[offset + 3] = 255;
        continue;
      }
      if (t !== 1) {
        pixels[offset] = 14;
        pixels[offset + 1] = 14;
        pixels[offset + 2] = 18;
        pixels[offset + 3] = 255;
        continue;
      }
      const fin = flowIn ? flowIn[i] : 0;
      const fout = flowOut ? flowOut[i] : 0;
      const mag = fin + fout;
      const net = fin - fout;
      // 闪烁用“真实时间”，避免 tick/s 提高导致屏闪
      const pulse = 0.88 + 0.12 * Math.sin(nowMs * 0.0028 + phaseFromIndex(i));
      // 让高亮更“稀疏”：只有当每 tick 传输量超过阈值才明显发光，并用非线性压缩小流量
      const FLOW_MIN = 0.0045; // 小于该值基本不高亮
      const FLOW_SCALE = 60; // (mag-FLOW_MIN)*FLOW_SCALE 映射到 0..1
      const magNorm = mag > FLOW_MIN ? clamp((mag - FLOW_MIN) * FLOW_SCALE, 0, 1) : 0;
      const intensity = (magNorm ** 1.9) * clamp(pulse, 0, 1);

      // 源（净流出）偏冷色，汇（净流入）偏暖色
      const src = net < 0;
      const hr = src ? 50 : 255;
      const hg = src ? 210 : 190;
      const hb = src ? 255 : 70;

      // 底色保留一点 gene 信息（便于识别叶/果），但整体更暗
      const eRaw = energy[i];
      const e = eRaw > 0 ? eRaw : 0;
      const g = gene[i];
      const gIdx = (g * 255) | 0;
      const eIdx = e < 40 ? ((e / 40) * 63) | 0 : 63;
      const lutOffset = (gIdx * 64 + eIdx) * 3;
      const value = Math.min(0.35, biomass[i] * 0.35 + Math.min(0.08, e * 0.0018));
      const scale = value * 255;
      let r = HSV_COEFF_LUT[lutOffset] * scale * 0.65;
      let gg = HSV_COEFF_LUT[lutOffset + 1] * scale * 0.65;
      let b = HSV_COEFF_LUT[lutOffset + 2] * scale * 0.65;

      r = r + (hr - r) * intensity;
      gg = gg + (hg - gg) * intensity;
      b = b + (hb - b) * intensity;
      pixels[offset] = clamp(r, 0, 255);
      pixels[offset + 1] = clamp(gg, 0, 255);
      pixels[offset + 2] = clamp(b, 0, 255);
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

export function paintWorldToPixelsView(world, pixels, view, outW, outH, options = {}) {
  const { type, biomass, energy, gene, age } = world.front;
  const showAgingGlow = !!options.showAgingGlow;
  const viewMode = options.viewMode || 'eco';
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : (typeof performance !== 'undefined' ? performance.now() : 0);
  const flow = world.flow;
  const flowIn = flow?.in;
  const flowOut = flow?.out;
  const terrain = world.terrain;
  const terrainLight = terrain?.light;
  const terrainLoss = terrain?.loss;
  const lightMin = terrain?.lightMin ?? 1;
  const lightMax = terrain?.lightMax ?? 1;
  const lossMin = terrain?.lossMin ?? 1;
  const lossMax = terrain?.lossMax ?? 1;

  const w = world.width | 0;
  const h = world.height | 0;
  const safeOutW = Math.max(1, outW | 0);
  const safeOutH = Math.max(1, outH | 0);
  const sx = Number.isFinite(view?.sx) ? view.sx : 0;
  const sy = Number.isFinite(view?.sy) ? view.sy : 0;
  const sw = Number.isFinite(view?.sw) && view.sw > 0 ? view.sw : w;
  const sh = Number.isFinite(view?.sh) && view.sh > 0 ? view.sh : h;

  for (let py = 0; py < safeOutH; py++) {
    const wy = Math.floor(sy + ((py + 0.5) * sh) / safeOutH);
    const y = wy < 0 ? 0 : (wy >= h ? (h - 1) : wy);
    const rowOff = py * safeOutW * 4;
    for (let px = 0; px < safeOutW; px++) {
      const wx = Math.floor(sx + ((px + 0.5) * sw) / safeOutW);
      const x = wx < 0 ? 0 : (wx >= w ? (w - 1) : wx);
      const i = y * w + x;
      const offset = rowOff + px * 4;
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
        pixels[offset] = 40 + lossNorm * 210;
        pixels[offset + 1] = 30 + lightNorm * 210;
        pixels[offset + 2] = 30 + (1 - lossNorm) * 60 + lightNorm * 150;
        pixels[offset + 3] = 255;
        continue;
      }

      if (viewMode === 'transfer') {
        if (t === 0) {
          const base = 10 + lightNorm * 10 + (1 - lossNorm) * 6;
          pixels[offset] = base;
          pixels[offset + 1] = base;
          pixels[offset + 2] = base + 4;
          pixels[offset + 3] = 255;
          continue;
        }
        if (t !== 1) {
          pixels[offset] = 14;
          pixels[offset + 1] = 14;
          pixels[offset + 2] = 18;
          pixels[offset + 3] = 255;
          continue;
        }
        const fin = flowIn ? flowIn[i] : 0;
        const fout = flowOut ? flowOut[i] : 0;
        const mag = fin + fout;
        const net = fin - fout;
        const pulse = 0.88 + 0.12 * Math.sin(nowMs * 0.0028 + phaseFromIndex(i));
        const FLOW_MIN = 0.0045;
        const FLOW_SCALE = 60;
        const magNorm = mag > FLOW_MIN ? clamp((mag - FLOW_MIN) * FLOW_SCALE, 0, 1) : 0;
        const intensity = (magNorm ** 1.9) * clamp(pulse, 0, 1);

        const src = net < 0;
        const hr = src ? 50 : 255;
        const hg = src ? 210 : 190;
        const hb = src ? 255 : 70;

        const eRaw = energy[i];
        const e = eRaw > 0 ? eRaw : 0;
        const g = gene[i];
        const gIdx = (g * 255) | 0;
        const eIdx = e < 40 ? ((e / 40) * 63) | 0 : 63;
        const lutOffset = (gIdx * 64 + eIdx) * 3;
        const value = Math.min(0.35, biomass[i] * 0.35 + Math.min(0.08, e * 0.0018));
        const scale = value * 255;
        let r = HSV_COEFF_LUT[lutOffset] * scale * 0.65;
        let gg = HSV_COEFF_LUT[lutOffset + 1] * scale * 0.65;
        let b = HSV_COEFF_LUT[lutOffset + 2] * scale * 0.65;

        r = r + (hr - r) * intensity;
        gg = gg + (hg - gg) * intensity;
        b = b + (hb - b) * intensity;
        pixels[offset] = clamp(r, 0, 255);
        pixels[offset + 1] = clamp(gg, 0, 255);
        pixels[offset + 2] = clamp(b, 0, 255);
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
      const gIdx = (g * 255) | 0;
      const eIdx = e < 40 ? ((e / 40) * 63) | 0 : 63;
      const lutOffset = (gIdx * 64 + eIdx) * 3;
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
}

export function drawFlowOverlay(ctx, world, view, canvasW, canvasH, nowMs = performance.now()) {
  const flow = world.flow;
  const flowOut = flow?.out;
  const flowVx = flow?.vx;
  const flowVy = flow?.vy;
  if (!flowOut || !flowVx || !flowVy) return;

  const startX = Math.max(0, Math.floor(view.sx));
  const endX = Math.min(world.width - 1, Math.ceil(view.sx + view.sw) - 1);
  const startY = Math.max(0, Math.floor(view.sy));
  const endY = Math.min(world.height - 1, Math.ceil(view.sy + view.sh) - 1);
  const cellW = canvasW / view.sw;
  const cellH = canvasH / view.sh;
  if (cellW < 4 || cellH < 4) return;

  // 低缩放时抽样画，避免太密太糊
  const step = Math.max(1, Math.floor(14 / Math.min(cellW, cellH)));

  ctx.save();
  ctx.lineWidth = Math.max(1, Math.min(2.2, Math.min(cellW, cellH) * 0.12));
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(120, 240, 255, 0.9)';
  ctx.fillStyle = 'rgba(120, 240, 255, 0.9)';

  for (let y = startY; y <= endY; y += step) for (let x = startX; x <= endX; x += step) {
    const i = y * world.width + x;
    const out = flowOut[i];
    // 箭头更“稀疏”：提高门槛，避免满屏线条造成屏闪感
    if (!(out > 0.006)) continue;
    const vx = flowVx[i];
    const vy = flowVy[i];
    const mag = Math.hypot(vx, vy);
    if (mag <= 1e-9 || mag < out * 0.28) continue;
    const dx = vx / mag;
    const dy = vy / mag;
    const pulse = 0.88 + 0.12 * Math.sin((nowMs || 0) * 0.0028 + phaseFromIndex(i));
    ctx.globalAlpha = 0.7 * pulse;

    const px = (x + 0.5 - view.sx) * cellW;
    const py = (y + 0.5 - view.sy) * cellH;
    const maxLen = Math.min(cellW, cellH) * 0.34;
    const len = Math.min(maxLen, Math.sqrt(out) * 14); // 非线性：小 out 更不显眼，大 out 才更长
    if (len < 1.2) continue;

    const ex = px + dx * len;
    const ey = py + dy * len;

    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // arrow head
    const ah = Math.max(2, Math.min(6, len * 0.35));
    const ax = -dy;
    const ay = dx;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - dx * ah + ax * (ah * 0.55), ey - dy * ah + ay * (ah * 0.55));
    ctx.lineTo(ex - dx * ah - ax * (ah * 0.55), ey - dy * ah - ay * (ah * 0.55));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawChart(ctx, w, h, biomassHistory, geneHistory, senescentHistory = []) {
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
  drawSeries(senescentHistory, '#fbbf24', 0, 1);
  ctx.fillStyle = 'rgba(243, 244, 246, 0.8)';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.fillText('Biomass(norm)', 36, 18);
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('Avg Gene', 124, 18);
  ctx.fillStyle = '#fbbf24';
  ctx.fillText('Senescent Ratio', 186, 18);
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

export function updateSkyBadge(orbitEl, simTime, sunSpeed, options = {}) {
  if (!orbitEl) return;
  const polarDay = !!options.polarDay;
  if (polarDay) {
    orbitEl.style.setProperty('--sun', '1');
    orbitEl.style.setProperty('--sun-x', '50');
    orbitEl.style.setProperty('--sun-y', '16');
    orbitEl.style.setProperty('--sun-a', '1');
    orbitEl.style.setProperty('--moon-x', '50');
    orbitEl.style.setProperty('--moon-y', '94');
    orbitEl.style.setProperty('--moon-a', '0');
    return;
  }
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
