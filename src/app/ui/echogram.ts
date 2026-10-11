import { FONT, fit, inkRamp, palette, rgb } from './draw';

/**
 * Scrolling echogram, drawn like an echo-sounder paper trace: distance from
 * the phone runs upward (0 m at the bottom edge, where the phone is), time
 * scrolls right to left, and ink density is the strength of moving echoes.
 */
export class Echogram {
  private readonly off: HTMLCanvasElement;
  private readonly offCtx: CanvasRenderingContext2D;
  private ramp: Uint8ClampedArray;
  private col: ImageData;
  private target: number | null = null;
  private breathing: number | null = null;
  private zone = 1.2;
  private dirty = true;
  private paused = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cells: number,
    private maxRange: number,
    private readonly columns = 470,
  ) {
    this.off = document.createElement('canvas');
    this.off.width = columns;
    this.off.height = cells;
    this.offCtx = this.off.getContext('2d')!;
    this.ramp = inkRamp();
    this.col = new ImageData(1, cells);
    this.clear();
  }

  clear(): void {
    const p = palette(true);
    this.ramp = inkRamp();
    this.offCtx.fillStyle = rgb(p.paper2);
    this.offCtx.fillRect(0, 0, this.columns, this.cells);
    this.dirty = true;
  }

  /** Force a redraw (after a resize or tab switch). */
  markDirty(): void {
    this.dirty = true;
  }

  setMaxRange(r: number): void {
    this.maxRange = r;
    this.dirty = true;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.dirty = true;
  }

  push(row: Float32Array): void {
    const ctx = this.offCtx;
    ctx.drawImage(this.off, -1, 0);
    const d = this.col.data;
    for (let c = 0; c < this.cells; c++) {
      const v = Math.max(0, Math.min(1, (row[c] - 9) / 24));
      const i = Math.round(v * 255) * 4;
      const o = (this.cells - 1 - c) * 4;
      d[o] = this.ramp[i];
      d[o + 1] = this.ramp[i + 1];
      d[o + 2] = this.ramp[i + 2];
      d[o + 3] = 255;
    }
    ctx.putImageData(this.col, this.columns - 1, 0);
    this.dirty = true;
  }

  setMarkers(target: number | null, breathing: number | null, zone: number): void {
    if (target !== this.target || breathing !== this.breathing || zone !== this.zone) this.dirty = true;
    this.target = target;
    this.breathing = breathing;
    this.zone = zone;
  }

  draw(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const { w, h, ctx } = fit(this.canvas);
    const p = palette();
    const padL = 30;
    const padR = 18;
    const padT = 8;
    const padB = 8;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, padL, padT, pw, ph);
    const yOf = (r: number) => padT + ph * (1 - r / this.maxRange);

    // Metre lines.
    ctx.font = FONT;
    ctx.lineWidth = 1;
    for (let m = 0; m <= Math.floor(this.maxRange); m++) {
      const y = yOf(m);
      ctx.strokeStyle = rgb(p.rule, 0.9);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + pw, y);
      ctx.stroke();
      ctx.fillStyle = rgb(p.graphite);
      ctx.fillText(m === 0 ? 'phone' : `${m} m`, 2, Math.min(h - 2, Math.max(12, y + 4)));
    }
    // Personal-space zone.
    const zy = yOf(this.zone);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = rgb(p.graphite, 0.8);
    ctx.beginPath();
    ctx.moveTo(padL, zy);
    ctx.lineTo(padL + pw, zy);
    ctx.stroke();
    ctx.setLineDash([]);

    // "Now" markers at the right edge.
    const x = padL + pw + 3;
    if (this.target !== null && this.target <= this.maxRange) {
      const y = yOf(this.target);
      ctx.fillStyle = rgb(p.ink);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 11, y - 6);
      ctx.lineTo(x + 11, y + 6);
      ctx.closePath();
      ctx.fill();
    }
    if (this.breathing !== null && this.breathing <= this.maxRange) {
      const y = yOf(this.breathing);
      ctx.strokeStyle = rgb(p.ink);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x + 6, y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.paused) {
      ctx.fillStyle = rgb(p.paper, 0.78);
      ctx.fillRect(padL, padT, pw, ph);
      ctx.fillStyle = rgb(p.graphite);
      ctx.font = '500 15px Barlow, system-ui, sans-serif';
      const msg = 'Sonar paused while the phone moves';
      ctx.fillText(msg, padL + (pw - ctx.measureText(msg).width) / 2, padT + ph / 2);
    }
  }
}
