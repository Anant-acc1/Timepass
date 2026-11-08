/**
 * Grid geometry: the three regular polygons that tile the plane.
 *
 * Only the equilateral triangle, the square and the regular hexagon can tile a plane on
 * their own (every edge and every interior angle equal), so those are the supported shapes.
 *
 * A geometry answers purely spatial questions in "unit space", where every polygon edge has
 * length 1. The renderer scales unit space to pixels. Edge `d` of a cell is the wall shared
 * with neighbour `d`; directions are small integers, so the maze logic needs no shape
 * specific code.
 *
 * Geometry interface (c = column, r = row):
 *   sides                  number of edges per cell
 *   cellScale              typical centre-to-centre spacing, in unit space (for sizing marks)
 *   bounds(cols, rows)     { w, h } of the whole grid in unit space
 *   center(c, r)           { x, y } centre of the cell
 *   vertices(c, r)         [{x, y}, ...] polygon corners
 *   edge(c, r, d)          [p, q] end points of wall d
 *   neighbor(c, r, d)      [c2, r2] across wall d (may lie outside the grid)
 *   opposite(c, r, d)      the wall of the neighbour that is the same physical edge
 *   cwStep(c, r)           +1 or -1: which way direction numbers run when going clockwise
 *   hops(c1, r1, c2, r2)   lower bound on the number of steps between two cells
 */

const SQRT3 = Math.sqrt(3);

/** Square: walls 0 top, 1 right, 2 bottom, 3 left (clockwise). */
const SquareGeometry = {
  name: 'square',
  label: 'Square',
  sides: 4,
  cellScale: 1,
  areaFactor: 1, // relative cell count that gives a comparable on-screen density

  bounds(cols, rows) {
    return { w: cols, h: rows };
  },
  center(c, r) {
    return { x: c + 0.5, y: r + 0.5 };
  },
  vertices(c, r) {
    return [
      { x: c, y: r },
      { x: c + 1, y: r },
      { x: c + 1, y: r + 1 },
      { x: c, y: r + 1 }
    ];
  },
  edge(c, r, d) {
    const v = this.vertices(c, r);
    return [v[d], v[(d + 1) % 4]];
  },
  neighbor(c, r, d) {
    if (d === 0) return [c, r - 1];
    if (d === 1) return [c + 1, r];
    if (d === 2) return [c, r + 1];
    return [c - 1, r];
  },
  opposite(c, r, d) {
    return (d + 2) % 4;
  },
  cwStep() {
    return 1;
  },
  hops(c1, r1, c2, r2) {
    return Math.abs(c1 - c2) + Math.abs(r1 - r2);
  },
  // Columns per row for a viewport: x extent per column, y extent per row
  stride: { x: 1, y: 1 }
};

/**
 * Hexagon: pointy-top, odd rows shifted right by half a cell.
 * Walls 0 NE, 1 E, 2 SE, 3 SW, 4 W, 5 NW (clockwise). Side length 1.
 */
const HexGeometry = {
  name: 'hexagon',
  label: 'Hexagon',
  sides: 6,
  cellScale: SQRT3,
  areaFactor: 0.85,

  bounds(cols, rows) {
    return { w: SQRT3 * (cols + (rows > 1 ? 0.5 : 0)), h: 1.5 * rows + 0.5 };
  },
  center(c, r) {
    return { x: SQRT3 * (c + 0.5 * (r & 1) + 0.5), y: 1 + 1.5 * r };
  },
  vertices(c, r) {
    const o = this.center(c, r);
    const out = [];
    for (let k = 0; k < 6; k++) {
      const a = ((-90 + 60 * k) * Math.PI) / 180;
      out.push({ x: o.x + Math.cos(a), y: o.y + Math.sin(a) });
    }
    return out;
  },
  edge(c, r, d) {
    const v = this.vertices(c, r);
    return [v[d], v[(d + 1) % 6]];
  },
  neighbor(c, r, d) {
    const odd = r & 1;
    switch (d) {
      case 0: return [odd ? c + 1 : c, r - 1];
      case 1: return [c + 1, r];
      case 2: return [odd ? c + 1 : c, r + 1];
      case 3: return [odd ? c : c - 1, r + 1];
      case 4: return [c - 1, r];
      default: return [odd ? c : c - 1, r - 1];
    }
  },
  opposite(c, r, d) {
    return (d + 3) % 6;
  },
  cwStep() {
    return 1;
  },
  hops(c1, r1, c2, r2) {
    // odd-r offset -> cube coordinates, then cube distance (exact for a hex grid)
    const x1 = c1 - (r1 - (r1 & 1)) / 2;
    const x2 = c2 - (r2 - (r2 & 1)) / 2;
    const dx = x1 - x2;
    const dz = r1 - r2;
    const dy = -dx - dz;
    return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  },
  stride: { x: SQRT3, y: 1.5 }
};

/**
 * Triangle: equilateral triangles in alternating rows of up / down pairs, side length 1.
 * A cell points up when (col + row) is even, down otherwise.
 * Walls 0 left slant, 1 right slant, 2 horizontal (the base of an up triangle, the top of a
 * down triangle). The horizontal neighbour is below for up triangles, above for down ones.
 */
const TRI_H = SQRT3 / 2;
const TriangleGeometry = {
  name: 'triangle',
  label: 'Triangle',
  sides: 3,
  cellScale: 1 / SQRT3,
  areaFactor: 1.6,

  isUp(c, r) {
    return ((c + r) & 1) === 0;
  },
  bounds(cols, rows) {
    return { w: 0.5 * cols + 0.5, h: TRI_H * rows };
  },
  center(c, r) {
    const top = r * TRI_H;
    return { x: 0.5 * (c + 1), y: top + (this.isUp(c, r) ? (2 * TRI_H) / 3 : TRI_H / 3) };
  },
  vertices(c, r) {
    const cx = 0.5 * (c + 1);
    const top = r * TRI_H;
    const bot = top + TRI_H;
    if (this.isUp(c, r)) {
      return [{ x: cx - 0.5, y: bot }, { x: cx, y: top }, { x: cx + 0.5, y: bot }]; // BL, apex, BR
    }
    return [{ x: cx - 0.5, y: top }, { x: cx, y: bot }, { x: cx + 0.5, y: top }]; // TL, apex, TR
  },
  edge(c, r, d) {
    // Vertex order is (v0, v1, v2); wall 0 = v0-v1 (left), wall 1 = v1-v2 (right), wall 2 = v2-v0
    const v = this.vertices(c, r);
    return [v[d], v[(d + 1) % 3]];
  },
  neighbor(c, r, d) {
    if (d === 0) return [c - 1, r];
    if (d === 1) return [c + 1, r];
    return [c, this.isUp(c, r) ? r + 1 : r - 1];
  },
  opposite(c, r, d) {
    return d === 0 ? 1 : d === 1 ? 0 : 2;
  },
  cwStep(c, r) {
    // Up triangles list their walls clockwise (0,1,2); down triangles list them 2,1,0
    return this.isUp(c, r) ? 1 : -1;
  },
  hops(c1, r1, c2, r2) {
    // Adjacent centres are at most 1/sqrt(3) apart, so straight-line distance / that is a bound
    const a = this.center(c1, r1);
    const b = this.center(c2, r2);
    return Math.hypot(a.x - b.x, a.y - b.y) * SQRT3;
  },
  stride: { x: 0.5, y: TRI_H }
};

const GEOMETRIES = {
  square: SquareGeometry,
  hexagon: HexGeometry,
  triangle: TriangleGeometry
};

function createGeometry(shape) {
  return GEOMETRIES[shape] || SquareGeometry;
}

/**
 * Picks grid dimensions for a shape so that roughly `cellCount` square-equivalent cells
 * fill a viewport of the given aspect ratio.
 */
function gridDimensions(shape, cellCount, aspect) {
  const g = createGeometry(shape);
  const n = cellCount * g.areaFactor;
  // Want (stride.x * cols) / (stride.y * rows) = aspect and cols * rows = n
  const rows = Math.max(5, Math.round(Math.sqrt((n * g.stride.x) / (g.stride.y * aspect))));
  const cols = Math.max(5, Math.round(n / rows));
  return { cols, rows };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GEOMETRIES, createGeometry, gridDimensions };
} else {
  window.GEOMETRIES = GEOMETRIES;
  window.createGeometry = createGeometry;
  window.gridDimensions = gridDimensions;
}
