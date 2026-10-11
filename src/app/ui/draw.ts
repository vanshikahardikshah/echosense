/** Canvas helpers shared by the phone app and the console. */

export interface Palette {
  paper: [number, number, number];
  paper2: [number, number, number];
  ink: [number, number, number];
  graphite: [number, number, number];
  rule: [number, number, number];
  amber: [number, number, number];
  crimson: [number, number, number];
}

function parse(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.slice(1).split('').map((x) => x + x).join('') : s.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const m = s.match(/(\d+(\.\d+)?)/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
}

let cached: Palette | null = null;
export function palette(refresh = false): Palette {
  if (cached && !refresh) return cached;
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string) => parse(cs.getPropertyValue(n) || '#000');
  cached = {
    paper: g('--paper'),
    paper2: g('--paper-2'),
    ink: g('--ink'),
    graphite: g('--graphite'),
    rule: g('--rule'),
    amber: g('--amber'),
    crimson: g('--crimson'),
  };
  return cached;
}

export function rgb(c: [number, number, number], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** Ink-density ramp: 0 = bare paper, 1 = full ink (the echo-sounder trace). */
export function inkRamp(steps = 256): Uint8ClampedArray {
  const p = palette();
  const out = new Uint8ClampedArray(steps * 4);
  for (let i = 0; i < steps; i++) {
    const v = i / (steps - 1);
    const t = Math.pow(v, 0.85);
    for (let k = 0; k < 3; k++) out[i * 4 + k] = p.paper2[k] + (p.ink[k] - p.paper2[k]) * t;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Size a canvas's backing store to its CSS box at device pixel ratio. Returns CSS size. */
export function fit(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number; ctx: CanvasRenderingContext2D } {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(r.width));
  const h = Math.max(10, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr, ctx };
}

export const FONT = "500 12px Barlow, system-ui, sans-serif";

export function drawLine(
  canvas: HTMLCanvasElement,
  ys: ArrayLike<number>,
  opts: { min: number; max: number; color?: [number, number, number]; fill?: boolean; xLabels?: [number, string][]; yLabels?: [number, string][] },
): void {
  const { w, h, ctx } = fit(canvas);
  const p = palette();
  ctx.clearRect(0, 0, w, h);
  const padL = opts.yLabels ? 34 : 6;
  const padB = opts.xLabels ? 18 : 6;
  const pw = w - padL - 6;
  const ph = h - padB - 6;
  ctx.font = FONT;
  ctx.fillStyle = rgb(p.graphite);
  ctx.strokeStyle = rgb(p.rule);
  ctx.lineWidth = 1;
  for (const [v, label] of opts.yLabels ?? []) {
    const y = 6 + ph * (1 - (v - opts.min) / (opts.max - opts.min));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - 6, y);
    ctx.stroke();
    ctx.fillText(label, 4, y + 4);
  }
  for (const [fx, label] of opts.xLabels ?? []) {
    const x = padL + pw * fx;
    ctx.fillText(label, Math.min(w - ctx.measureText(label).width - 2, Math.max(padL, x - 8)), h - 4);
  }
  if (ys.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < ys.length; i++) {
    const x = padL + (pw * i) / (ys.length - 1);
    const v = Math.max(opts.min, Math.min(opts.max, ys[i]));
    const y = 6 + ph * (1 - (v - opts.min) / (opts.max - opts.min));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = rgb(opts.color ?? p.ink);
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (opts.fill) {
    ctx.lineTo(padL + pw, 6 + ph);
    ctx.lineTo(padL, 6 + ph);
    ctx.closePath();
    ctx.fillStyle = rgb(opts.color ?? p.ink, 0.12);
    ctx.fill();
  }
}

/** Draw a heat image (rows x cols, row 0 at the bottom) with the ink ramp. */
export function drawHeat(
  canvas: HTMLCanvasElement,
  data: ArrayLike<number>,
  rows: number,
  cols: number,
  lo: number,
  hi: number,
  labels?: { x?: [number, string][]; y?: [number, string][] },
): void {
  const { w, h, ctx } = fit(canvas);
  const p = palette();
  ctx.clearRect(0, 0, w, h);
  const ramp = inkRamp();
  const img = new ImageData(cols, rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = Math.max(0, Math.min(1, (data[r * cols + c] - lo) / (hi - lo)));
      const idx = Math.round(v * 255) * 4;
      const o = ((rows - 1 - r) * cols + c) * 4;
      img.data[o] = ramp[idx];
      img.data[o + 1] = ramp[idx + 1];
      img.data[o + 2] = ramp[idx + 2];
      img.data[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  off.getContext('2d')!.putImageData(img, 0, 0);
  const padL = labels?.y ? 34 : 0;
  const padB = labels?.x ? 18 : 0;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, padL, 0, w - padL, h - padB);
  ctx.font = FONT;
  ctx.fillStyle = rgb(p.graphite);
  for (const [fy, label] of labels?.y ?? []) ctx.fillText(label, 3, Math.max(12, (h - padB) * (1 - fy) + 4));
  for (const [fx, label] of labels?.x ?? []) {
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(w - tw - 2, Math.max(padL, padL + (w - padL) * fx - tw / 2)), h - 4);
  }
}
