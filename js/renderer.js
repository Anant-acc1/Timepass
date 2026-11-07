/**
 * City Grow-style renderer for the maze race, modelled on KDE's "Simple City Grow".
 *
 * Look:
 *  - pure black field with faint maze passages underneath
 *  - each solver grows its own city: thin, fully saturated roads from a parent cell to a
 *    child cell, with a translucent tinted block on every visited cell
 *  - when a solver reaches the exit, its route is drawn once in that solver's colour
 *  - when a round ends the city is erased newest-first (the reverse of growth)
 *
 * Performance:
 *  - the black field and passages live in a static base layer; finished roads are
 *    committed once to a city layer. A frame is two full-canvas blits plus a few small
 *    primitives for roads still extending and the growing heads
 *  - rendering is capped at TARGET_FPS (City Grow itself ticks at 25 fps); the
 *    simulation still steps every animation frame
 *  - no backdrop blur, no gradients, no particles, and no per-frame string building
 */

const MAX_DPR = 1.5;     // pixel fill dominates cost on HiDPI screens, so cap the backing store
const TARGET_FPS = 30;   // render cadence
const TAU = Math.PI * 2;
const PASSAGE_COLOR = 'rgba(255, 255, 255, 0.07)';
const BLOCK_FRACTION = 0.6; // block size as a fraction of the cell

function nowSeconds() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

/** Colours for one growth side of a solver. Built once per round, not per frame. */
function makePalette(hue) {
  const h = hue.toFixed(1);
  return {
    road: `hsl(${h}, 100%, 55%)`,
    block: `hsla(${h}, 100%, 50%, 0.22)`,
    tip: `hsl(${h}, 100%, 80%)`
  };
}

const FALLBACK_PALETTE = makePalette(200);

class MazeRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.cellSize = 24;
    this.offsetX = 0;
    this.offsetY = 0;
    this.roadWidth = 2;

    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // Static layer: black field, maze passages
    this.baseCanvas = document.createElement('canvas');
    this.baseCtx = this.baseCanvas.getContext('2d');
    // City layer: committed roads, blocks and winning routes (transparent)
    this.cityCanvas = document.createElement('canvas');
    this.cityCtx = this.cityCanvas.getContext('2d');

    this.cityOps = [];                    // committed draw ops, in growth order
    this.solverProgress = new WeakMap();  // solver -> number of records already committed
    this.highlighted = new WeakSet();     // solvers whose route is already in the city layer
    this.inFlight = [];                   // scratch list, reused every frame
    this.phase = 'grow';                  // 'grow' | 'erasing' | 'erased'
    this.eraseRate = 1;                   // ops removed per rendered frame while erasing
    this.eraseDuration = 1.5;             // seconds
    this.growthDuration = 0.18;           // seconds a road segment takes to extend
    this.builtFor = null;
    this.layoutDirty = true;

    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.layoutDirty = true;
  }

  computeLayout(cols, rows) {
    const padding = Math.min(this.width, this.height) * 0.055;
    const sizeX = (this.width - padding * 2) / cols;
    const sizeY = (this.height - padding * 2) / rows;
    this.cellSize = Math.max(6, Math.floor(Math.min(sizeX, sizeY)));

    this.offsetX = Math.floor((this.width - this.cellSize * cols) / 2);
    this.offsetY = Math.floor((this.height - this.cellSize * rows) / 2);
    this.roadWidth = Math.min(3, Math.max(1.5, this.cellSize * 0.1));

    this.layoutDirty = true;
  }

  /**
   * Gives each solver a random hue for this round, spread around the colour wheel
   * so the competing cities are distinguishable.
   */
  assignPalette(solvers) {
    const base = Math.random() * 360;
    const n = Math.max(1, solvers.length);
    solvers.forEach((s, i) => {
      const fwd = (base + (i * 360) / n + (Math.random() * 16 - 8) + 360) % 360;
      const bwd = (fwd + 40) % 360;
      s.pal = { forward: makePalette(fwd), backward: makePalette(bwd) };
      s.color = s.pal.forward.road;
      s.backwardColor = s.pal.backward.road;
    });
  }

  sidePalette(solver, side) {
    return (solver.pal && solver.pal[side === 'backward' ? 'backward' : 'forward']) || FALLBACK_PALETTE;
  }

  cellX(col) {
    return this.offsetX + (col + 0.5) * this.cellSize;
  }

  cellY(row) {
    return this.offsetY + (row + 0.5) * this.cellSize;
  }

  /** Forget the city drawn for the current maze; the next render redraws from scratch. */
  resetRound() {
    this.layoutDirty = true;
  }

  /** Begin removing the finished city, newest roads first (reverse of growth). */
  startErase() {
    if (this.phase !== 'grow') return;
    this.phase = 'erasing';
    this.eraseRate = Math.max(1, Math.ceil(this.cityOps.length / (this.eraseDuration * TARGET_FPS)));
  }

  // ---------------------------------------------------------------------------
  // Main render pipeline
  // ---------------------------------------------------------------------------

  render(maze, solvers) {
    const now = nowSeconds();

    if (this.layoutDirty || this.builtFor !== maze) {
      this.rebuildLayers(maze);
    }
    if (this.phase === 'erasing') this.stepErase();

    // Commit finished growth to the city layer; collect segments still extending
    this.inFlight.length = 0;
    for (const solver of solvers) {
      this.growCity(solver, now);
    }

    // Two blits cover the whole frame (the base is opaque, so no clear is needed)
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.drawImage(this.cityCanvas, 0, 0);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const item of this.inFlight) {
      this.drawInFlight(ctx, item.solver, item.rec, now);
    }
    if (this.phase === 'grow') {
      for (const solver of solvers) {
        if (solver.status === 'running' && solver.records.length > 0) {
          this.drawHead(ctx, solver, solver.records[solver.records.length - 1], now);
        }
      }
    }
    this.drawHubs(ctx, maze);
  }

  /** Rebuilds cached layers for a new maze or a new canvas size. */
  rebuildLayers(maze) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    this.baseCanvas.width = W;
    this.baseCanvas.height = H;
    this.cityCanvas.width = W;
    this.cityCanvas.height = H;

    const b = this.baseCtx;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.fillStyle = '#000';
    b.fillRect(0, 0, W, H);

    b.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    b.strokeStyle = PASSAGE_COLOR;
    b.lineWidth = 1;
    b.lineCap = 'round';
    b.beginPath();
    for (let r = 0; r < maze.rows; r++) {
      for (let c = 0; c < maze.cols; c++) {
        const cell = maze.grid[r][c];
        const x = this.cellX(c);
        const y = this.cellY(r);
        if (!cell.walls.right && c + 1 < maze.cols) {
          b.moveTo(x, y);
          b.lineTo(this.cellX(c + 1), y);
        }
        if (!cell.walls.bottom && r + 1 < maze.rows) {
          b.moveTo(x, y);
          b.lineTo(x, this.cellY(r + 1));
        }
      }
    }
    b.stroke();

    this.cityCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.cityCtx.clearRect(0, 0, W, H);
    this.cityOps = [];
    this.solverProgress = new WeakMap();
    this.highlighted = new WeakSet();
    this.phase = 'grow';
    this.builtFor = maze;
    this.layoutDirty = false;
  }

  /**
   * Moves finished visits from a solver into the city layer. Visits are born in
   * order, so the committed set is always a prefix of solver.records. Also commits the
   * solver's route once the solver has finished and every visit is in the city.
   */
  growCity(solver, now) {
    const records = solver.records;
    let committed = this.solverProgress.get(solver) || 0;

    while (committed < records.length) {
      const rec = records[committed];
      if (now - rec.birthTime < this.growthDuration) break;
      if (this.phase === 'grow') this.commitRecord(solver, rec);
      committed++;
    }
    this.solverProgress.set(solver, committed);

    for (let i = committed; i < records.length; i++) {
      this.inFlight.push({ solver, rec: records[i] });
    }

    if (
      this.phase === 'grow' &&
      solver.status === 'finished' &&
      committed === records.length &&
      solver.path && solver.path.length > 1 &&
      !this.highlighted.has(solver)
    ) {
      this.highlighted.add(solver);
      this.commitRoute(solver);
    }
  }

  commitRecord(solver, rec) {
    const pal = this.sidePalette(solver, rec.side);
    const cx = this.cellX(rec.cell.col);
    const cy = this.cellY(rec.cell.row);

    if (rec.parent) {
      const s = this.cellSize * BLOCK_FRACTION;
      this.paintOps([
        { type: 'block', x: cx - s / 2, y: cy - s / 2, s, color: pal.block },
        {
          type: 'road',
          x1: this.cellX(rec.parent.col),
          y1: this.cellY(rec.parent.row),
          x2: cx,
          y2: cy,
          w: this.roadWidth,
          color: pal.road
        }
      ]);
    } else {
      this.paintOps([{ type: 'dot', x: cx, y: cy, r: this.cellSize * 0.2, color: pal.tip }]);
    }
  }

  /** The winning route, drawn once in the finishing solver's own colour. */
  commitRoute(solver) {
    const pts = solver.path.map((c) => ({ x: this.cellX(c.col), y: this.cellY(c.row) }));
    this.paintOps([{ type: 'route', pts, w: this.roadWidth * 2.6, color: solver.color }]);
  }

  /** Paints ops into the city layer and records them so they can be erased later. */
  paintOps(ops) {
    const ctx = this.cityCtx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const op of ops) {
      this.drawOp(ctx, op, false);
      this.cityOps.push(op);
    }
    ctx.restore();
  }

  /**
   * Draws one committed op. When erasing, the context is in destination-out mode, so
   * the op's colour is irrelevant except that it must be opaque. Blocks are erased
   * with an opaque fill, and roads and routes are widened slightly to cover antialiasing.
   */
  drawOp(ctx, op, erase) {
    if (op.type === 'block') {
      ctx.fillStyle = erase ? '#000' : op.color;
      const pad = erase ? 1 : 0;
      ctx.fillRect(op.x - pad, op.y - pad, op.s + pad * 2, op.s + pad * 2);
    } else if (op.type === 'road') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = erase ? op.w + 1 : op.w;
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
    } else if (op.type === 'route') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = erase ? op.w + 2 : op.w;
      ctx.beginPath();
      op.pts.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    } else if (op.type === 'dot') {
      ctx.fillStyle = erase ? '#000' : op.color;
      ctx.beginPath();
      ctx.arc(op.x, op.y, op.r, 0, TAU);
      ctx.fill();
    }
  }

  /** Removes the most recently committed ops from the city layer. */
  stepErase() {
    const ctx = this.cityCtx;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < this.eraseRate && this.cityOps.length > 0; i++) {
      this.drawOp(ctx, this.cityOps.pop(), true);
    }
    ctx.restore();

    if (this.cityOps.length === 0) {
      this.phase = 'erased';
    }
  }

  /** A road segment still extending from its parent cell towards its cell. */
  drawInFlight(ctx, solver, rec, now) {
    const pal = this.sidePalette(solver, rec.side);
    const cs = this.cellSize;
    const cx = this.cellX(rec.cell.col);
    const cy = this.cellY(rec.cell.row);
    const p = easeOutCubic(clamp01((now - rec.birthTime) / this.growthDuration));

    if (!rec.parent) {
      ctx.globalAlpha = p;
      ctx.fillStyle = pal.tip;
      ctx.beginPath();
      ctx.arc(cx, cy, cs * 0.2, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    const x1 = this.cellX(rec.parent.col);
    const y1 = this.cellY(rec.parent.row);
    const tx = x1 + (cx - x1) * p;
    const ty = y1 + (cy - y1) * p;

    const s = cs * BLOCK_FRACTION;
    ctx.globalAlpha = p;
    ctx.fillStyle = pal.block;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.road;
    ctx.lineWidth = this.roadWidth;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(tx, ty);
    ctx.stroke();
  }

  /** Solid leading dot at the tip of a solver's city. */
  drawHead(ctx, solver, rec, now) {
    const pal = this.sidePalette(solver, rec.side);
    let x = this.cellX(rec.cell.col);
    let y = this.cellY(rec.cell.row);
    if (rec.parent) {
      const p = easeOutCubic(clamp01((now - rec.birthTime) / this.growthDuration));
      const x1 = this.cellX(rec.parent.col);
      const y1 = this.cellY(rec.parent.row);
      x = x1 + (x - x1) * p;
      y = y1 + (y - y1) * p;
    }
    ctx.fillStyle = pal.tip;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, this.roadWidth * 1.1), 0, TAU);
    ctx.fill();
  }

  drawHubs(ctx, maze) {
    const cs = this.cellSize;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = Math.max(1, this.roadWidth * 0.8);
    for (const cell of [maze.start, maze.exit]) {
      if (!cell) continue;
      ctx.beginPath();
      ctx.arc(this.cellX(cell.col), this.cellY(cell.row), cs * 0.3, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
