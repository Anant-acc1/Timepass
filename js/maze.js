/**
 * Maze Generation & Data Structure Module
 *
 * The maze lives on a grid of regular polygons (squares, hexagons or triangles, see
 * grid.js). Cells address their neighbours through numbered walls, so every generator and
 * solver works on any shape.
 *
 * Generation algorithms (all produce a spanning tree, so the maze is always solvable):
 * - Hilbert Spacefill + shortcuts - curved regions, several competing routes
 * - Recursive Backtracker (DFS)   - long, winding corridors
 * - Randomized Prim's             - bushy, many short branches
 * - Randomized Kruskal's          - uniform, balanced
 * - Hunt and Kill                 - organic, mixed
 * - Wilson's                      - unbiased (uniform spanning tree) via loop-erased walks
 * - Aldous-Broder                 - unbiased, from a plain random walk
 * - Growing Tree                  - blend of backtracker and Prim's
 * - Binary Tree                   - each cell links to one earlier neighbour (diagonal bias)
 * Optional braiding adds cycles, and optional weighted terrain assigns a movement cost
 * to every cell.
 *
 * Every wall removal is appended to `carveLog` (pairs of cell indices) so the renderer can
 * replay the generation as an animation.
 */

/**
 * Biomes: each is a set of terrain classes. Cost is what a solver pays to step onto a cell of
 * that class (a step between two cells costs the average of the two). Desert terrain slows
 * solvers down; tundra terrain (snow, ice) is cheaper than plain ground, so the cheapest route
 * and the shortest route disagree in different ways in each biome.
 */
const BIOMES = {
  desert: [
    { id: 0, name: 'Plain', cost: 1, share: 0.55, tint: 'rgba(255, 255, 255, 0.035)' },
    { id: 1, name: 'Sand', cost: 2, share: 0.2, tint: 'rgba(214, 176, 82, 0.13)' },
    { id: 2, name: 'Mud', cost: 4, share: 0.15, tint: 'rgba(150, 92, 44, 0.24)' },
    { id: 3, name: 'Water', cost: 8, share: 0.1, tint: 'rgba(36, 112, 255, 0.25)' }
  ],
  tundra: [
    { id: 0, name: 'Plain', cost: 1, share: 0.4, tint: 'rgba(255, 255, 255, 0.035)' },
    { id: 1, name: 'Snow', cost: 0.5, share: 0.27, tint: 'rgba(255, 255, 255, 0.28)' },
    { id: 2, name: 'Ice', cost: 0.25, share: 0.18, tint: 'rgba(228, 246, 255, 0.46)' },
    { id: 3, name: 'Water', cost: 8, share: 0.15, tint: 'rgba(36, 112, 255, 0.25)' }
  ]
};
const BIOME_IDS = Object.keys(BIOMES);
const GENERATOR_IDS = ['spacefill', 'backtracker', 'prims', 'kruskal', 'huntandkill', 'wilson', 'aldousbroder', 'growingtree', 'binarytree'];
const TERRAINS = BIOMES.desert; // default set (kept for older callers)

class MazeCell {
  constructor(col, row, index, sides) {
    this.col = col;
    this.row = row;
    this.index = index;
    this.walls = new Array(sides).fill(true); // walls[d] is true while the wall to neighbour d stands
    this.nbrs = new Array(sides).fill(null);  // neighbour cell across wall d, or null at the border
    this.back = new Array(sides).fill(-1);    // the neighbour's wall number for the same edge
    this.adj = [];                            // non-null neighbours (no particular meaning to order)
    this.cx = 0;                              // centre in unit space
    this.cy = 0;
    this.terrain = 0;
    this.cost = 1;
    this.visited = false;
  }
}

class Maze {
  constructor(cols, rows, shape = 'square') {
    this.cols = Math.max(5, cols);
    this.rows = Math.max(5, rows);
    this.shape = shape;
    this.geom = createGeometry(shape);
    this.grid = [];
    this.cells = []; // flat, row-major; cells[row * cols + col]
    this.start = null;
    this.exit = null;
    this.hasTerrain = false;
    this.terrains = BIOMES.desert; // terrain classes in use (set by generate)
    this.minCost = 1;              // cheapest single step, keeps A* heuristics admissible
    this.carveLog = [];
    this.initGrid();
  }

  initGrid() {
    const { cols, rows, geom } = this;
    const sides = geom.sides;

    this.grid = [];
    this.cells = [];
    this.carveLog = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cell = new MazeCell(c, r, r * cols + c, sides);
        const ctr = geom.center(c, r);
        cell.cx = ctr.x;
        cell.cy = ctr.y;
        row.push(cell);
        this.cells.push(cell);
      }
      this.grid.push(row);
    }

    for (const cell of this.cells) {
      for (let d = 0; d < sides; d++) {
        const [nc, nr] = geom.neighbor(cell.col, cell.row, d);
        const n = this.getCell(nc, nr);
        if (n) {
          cell.nbrs[d] = n;
          cell.back[d] = geom.opposite(cell.col, cell.row, d);
          cell.adj.push(n);
        }
      }
    }

    this.start = { col: 0, row: 0 };
    this.exit = { col: cols - 1, row: rows - 1 };
  }

  getCell(col, row) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return null;
    }
    return this.grid[row][col];
  }

  /** All neighbours as { cell, dir, opp }. */
  getNeighbors(cell) {
    const out = [];
    for (let d = 0; d < cell.nbrs.length; d++) {
      const n = cell.nbrs[d];
      if (n) out.push({ cell: n, dir: d, opp: cell.back[d] });
    }
    return out;
  }

  /** Neighbours reachable through an open wall. */
  getPassableNeighbors(cell) {
    const out = [];
    const { walls, nbrs } = cell;
    for (let d = 0; d < walls.length; d++) {
      if (!walls[d] && nbrs[d]) out.push(nbrs[d]);
    }
    return out;
  }

  /** Index of the wall of `a` that faces `b`, or -1 when they are not adjacent. */
  wallToward(a, b) {
    for (let d = 0; d < a.nbrs.length; d++) {
      if (a.nbrs[d] === b) return d;
    }
    return -1;
  }

  removeWallBetween(a, b) {
    const d = this.wallToward(a, b);
    if (d < 0 || !a.walls[d]) return; // not adjacent, or already open
    a.walls[d] = false;
    b.walls[a.back[d]] = false;
    this.carveLog.push(a.index, b.index);
  }

  /** Lower bound on the cost between two cells (hops x cheapest step; the A* style heuristic). */
  dist(a, b) {
    return this.geom.hops(a.col, a.row, b.col, b.row) * this.minCost;
  }

  /** Straight-line distance between cell centres, in unit space. */
  euclid(a, b) {
    const ca = this.grid[a.row][a.col];
    const cb = this.grid[b.row][b.col];
    return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy);
  }

  /** Cost of moving between two adjacent cells (symmetric, so both search directions agree). */
  edgeCost(a, b) {
    return (a.cost + b.cost) / 2;
  }

  /** Total terrain cost of walking a path of cells. */
  pathCost(path) {
    let total = 0;
    for (let i = 1; i < path.length; i++) total += this.edgeCost(path[i - 1], path[i]);
    return total;
  }

  /**
   * Generates a guaranteed solvable maze using the selected algorithm.
   * options.terrain: also assign weighted terrain to the cells.
   */
  generate(algorithm = 'spacefill', braidFactor = 0.08, options = {}) {
    // 'random' picks a generator (and below, a biome) for this maze; the choice is kept on the maze
    if (algorithm === 'random') algorithm = GENERATOR_IDS[Math.floor(Math.random() * GENERATOR_IDS.length)];
    this.algorithm = algorithm;
    this.initGrid();

    if (algorithm === 'spacefill') {
      // Builds its own loops (shortcuts), so it skips the generic braid below
      this.generateSpacefill(braidFactor);
    } else {
      switch (algorithm) {
        case 'prims':
          this.generatePrims();
          break;
        case 'kruskal':
          this.generateKruskal();
          break;
        case 'huntandkill':
          this.generateHuntAndKill();
          break;
        case 'wilson':
          this.generateWilson();
          break;
        case 'aldousbroder':
          this.generateAldousBroder();
          break;
        case 'growingtree':
          this.generateGrowingTree();
          break;
        case 'binarytree':
          this.generateBinaryTree();
          break;
        case 'backtracker':
        default:
          this.generateRecursiveBacktracker();
          break;
      }

      // Apply optional braiding to introduce alternative paths & loops
      if (braidFactor > 0) {
        this.applyBraid(braidFactor);
      }
    }

    // Find the furthest two points in the maze for Start & Exit
    this.computeLongestPathEndpoints();

    this.hasTerrain = !!options.terrain;
    this.biome = options.biome === 'random'
      ? BIOME_IDS[Math.floor(Math.random() * BIOME_IDS.length)]
      : (BIOMES[options.biome] ? options.biome : 'desert');
    this.terrains = BIOMES[this.biome];
    this.minCost = this.hasTerrain ? Math.min(...this.terrains.map((t) => t.cost)) : 1;
    if (this.hasTerrain) this.generateTerrain();

    // Analyze topological junctions for city plazas and roundabouts
    this.computeTopology();
  }

  // ---------------------------------------------------------------------------
  // Terrain
  // ---------------------------------------------------------------------------

  /**
   * Assigns each cell a terrain class from smooth two-octave value noise, so plain, sand,
   * mud and water form connected patches instead of speckle. Class sizes follow TERRAINS[].share
   * exactly (the noise is ranked, not thresholded), and start and exit are always plain.
   */
  generateTerrain() {
    const { w, h } = this.geom.bounds(this.cols, this.rows);
    const span = Math.max(w, h);

    const makeOctave = (cellsAcross) => {
      const gw = Math.ceil((w / span) * cellsAcross) + 2;
      const gh = Math.ceil((h / span) * cellsAcross) + 2;
      const lattice = new Float32Array(gw * gh);
      for (let i = 0; i < lattice.length; i++) lattice[i] = Math.random();
      return (x, y) => {
        const fx = (x / span) * cellsAcross;
        const fy = (y / span) * cellsAcross;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const at = (ix, iy) => lattice[iy * gw + ix];
        const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
        const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
        return top * (1 - sy) + bottom * sy;
      };
    };

    const coarse = makeOctave(4 + Math.random() * 2);
    const fine = makeOctave(10 + Math.random() * 3);
    const ranked = this.cells
      .map((cell) => ({ cell, v: coarse(cell.cx, cell.cy) * 0.7 + fine(cell.cx, cell.cy) * 0.3 }))
      .sort((a, b) => a.v - b.v);

    // Lowest values become plain, then sand, mud, water (patches nest like shorelines)
    let at = 0;
    for (const t of this.terrains) {
      const upTo = t.id === this.terrains.length - 1 ? ranked.length : at + Math.round(t.share * ranked.length);
      for (; at < upTo; at++) {
        ranked[at].cell.terrain = t.id;
        ranked[at].cell.cost = t.cost;
      }
    }

    for (const p of [this.start, this.exit]) {
      const cell = this.getCell(p.col, p.row);
      cell.terrain = 0;
      cell.cost = this.terrains[0].cost;
    }
  }

  // ---------------------------------------------------------------------------
  // Generators
  // ---------------------------------------------------------------------------

  randomCell() {
    return this.cells[Math.floor(Math.random() * this.cells.length)];
  }

  /**
   * Space-filling maze with varied routes.
   *
   * 1. Rank every cell along a Hilbert curve covering the grid.
   * 2. Carve a spanning tree with a Prim-style search whose frontier choice is
   *    biased towards cells close (in curve order) to the last carved cell. This
   *    gives coherent curved regions, with occasional jumps that create long,
   *    winding branches. The tree guarantees a solution from start to exit.
   * 3. Remove walls between cells that are far apart along the tree. Each removal
   *    is a shortcut that cuts a long tree route, so the solvers' routes differ and
   *    the shortest path is not the tree path. Short loops are removed less often.
   *    Because only walls are removed, every tree edge (the solution) stays open.
   */
  generateSpacefill(loopFactor = 0.1) {
    const cells = this.cells;
    const N = cells.length;

    // 1. Hilbert rank for each cell, from its position in unit space so every shape works
    const { w, h } = this.geom.bounds(this.cols, this.rows);
    let side = 1;
    while (side < Math.sqrt(N) * 1.4) side *= 2;
    const hilbertKey = (x, y) => {
      let d = 0;
      for (let s = side / 2; s >= 1; s /= 2) {
        const rx = (x & s) > 0 ? 1 : 0;
        const ry = (y & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        if (ry === 0) {
          if (rx === 1) {
            x = side - 1 - x;
            y = side - 1 - y;
          }
          const t = x;
          x = y;
          y = t;
        }
      }
      return d;
    };
    const keys = cells.map((cell) => {
      const gx = Math.min(side - 1, Math.floor((cell.cx / w) * side));
      const gy = Math.min(side - 1, Math.floor((cell.cy / h) * side));
      return { i: cell.index, k: hilbertKey(gx, gy) };
    });
    keys.sort((a, b) => a.k - b.k);
    const rank = new Array(N);
    keys.forEach((e, r) => { rank[e.i] = r; });

    // 2. Biased Prim spanning tree
    const parent = new Array(N).fill(-1);
    const depth = new Array(N).fill(0);
    const inTree = new Array(N).fill(false);
    const spread = Math.max(4, N * 0.03);

    const frontier = []; // entries: { to, from }
    const carve = (i, from) => {
      inTree[i] = true;
      if (from >= 0) {
        parent[i] = from;
        depth[i] = depth[from] + 1;
        this.removeWallBetween(cells[from], cells[i]);
      }
      for (const n of cells[i].adj) {
        if (!inTree[n.index]) frontier.push({ to: n.index, from: i });
      }
    };

    let cursor = Math.floor(Math.random() * N);
    carve(cursor, -1);
    while (frontier.length > 0) {
      let best = frontier.length - 1; // depth-first step: long, winding corridors
      if (Math.random() > 0.75) {
        // Space-filling step: jump to the frontier cell nearest the curve position
        let bestScore = Infinity;
        for (let f = 0; f < frontier.length; f++) {
          const score = Math.abs(rank[frontier[f].to] - rank[cursor]) + Math.random() * spread;
          if (score < bestScore) {
            bestScore = score;
            best = f;
          }
        }
      }
      const entry = frontier[best];
      frontier[best] = frontier[frontier.length - 1];
      frontier.pop();
      if (inTree[entry.to]) continue;

      carve(entry.to, entry.from);
      cursor = entry.to;
    }

    // 3. Shortcut walls between cells that are far apart along the tree
    const treeDistance = (a, b) => {
      let d = 0;
      while (a !== b) {
        if (depth[a] >= depth[b]) a = parent[a];
        else b = parent[b];
        d++;
      }
      return d;
    };

    const candidates = [];
    for (let i = 0; i < N; i++) {
      for (const n of cells[i].adj) {
        const j = n.index;
        if (j < i) continue; // each pair once
        if (parent[i] === j || parent[j] === i) continue; // already a tree edge
        candidates.push({ a: i, b: j, d: treeDistance(i, j) });
      }
    }

    const maxD = candidates.reduce((m, e) => Math.max(m, e.d), 0);
    const longCut = Math.max(6, maxD * 0.45);
    const longRate = Math.min(0.9, loopFactor * 0.5);
    const shortRate = Math.min(0.5, loopFactor * 0.15);

    for (const e of candidates) {
      const rate = e.d >= longCut ? longRate : shortRate;
      if (Math.random() < rate) {
        this.removeWallBetween(cells[e.a], cells[e.b]);
      }
    }
  }

  computeTopology() {
    this.junctions = [];
    for (const cell of this.cells) {
      const passages = this.getPassableNeighbors(cell);
      cell.passagesCount = passages.length;
      cell.isJunction = passages.length >= 3;
      cell.isDeadEnd = passages.length === 1;
      cell.isCorridor = passages.length === 2;
      if (cell.isJunction) {
        this.junctions.push(cell);
      }
    }
  }

  /**
   * Recursive Backtracker (Depth-First Search)
   */
  generateRecursiveBacktracker() {
    const stack = [];
    const startCell = this.randomCell();

    startCell.visited = true;
    stack.push(startCell);

    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const neighbors = current.adj.filter((n) => !n.visited);

      if (neighbors.length > 0) {
        // Pick random unvisited neighbor
        const chosen = neighbors[Math.floor(Math.random() * neighbors.length)];
        this.removeWallBetween(current, chosen);
        chosen.visited = true;
        stack.push(chosen);
      } else {
        stack.pop();
      }
    }

    this.resetCellVisited();
  }

  /**
   * Randomized Prim's Algorithm
   */
  generatePrims() {
    const walls = [];
    const startCell = this.randomCell();
    startCell.visited = true;

    for (const n of startCell.adj) walls.push({ c1: startCell, c2: n });

    while (walls.length > 0) {
      const randomIndex = Math.floor(Math.random() * walls.length);
      const { c1, c2 } = walls[randomIndex];
      walls[randomIndex] = walls[walls.length - 1];
      walls.pop();

      if (!c2.visited) {
        c2.visited = true;
        this.removeWallBetween(c1, c2);

        for (const n of c2.adj) {
          if (!n.visited) walls.push({ c1: c2, c2: n });
        }
      }
    }

    this.resetCellVisited();
  }

  /**
   * Randomized Kruskal's Algorithm with Disjoint Set Union (DSU)
   */
  generateKruskal() {
    const total = this.cells.length;
    const parent = new Int32Array(total);
    for (let i = 0; i < total; i++) parent[i] = i;

    const find = (i) => {
      let root = i;
      while (root !== parent[root]) root = parent[root];
      let curr = i;
      while (curr !== root) {
        const next = parent[curr];
        parent[curr] = root;
        curr = next;
      }
      return root;
    };

    const union = (i, j) => {
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) {
        parent[rootI] = rootJ;
        return true;
      }
      return false;
    };

    // Collect every internal wall once
    const edges = [];
    for (const c1 of this.cells) {
      for (const c2 of c1.adj) {
        if (c2.index > c1.index) edges.push({ c1, c2 });
      }
    }

    // Shuffle edges (Fisher-Yates)
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }

    for (const edge of edges) {
      if (union(edge.c1.index, edge.c2.index)) {
        this.removeWallBetween(edge.c1, edge.c2);
      }
    }

    this.resetCellVisited();
  }

  /**
   * Hunt and Kill Algorithm
   */
  generateHuntAndKill() {
    let current = this.randomCell();
    current.visited = true;

    while (current) {
      // Walk phase
      const unvisitedNeighbors = current.adj.filter((n) => !n.visited);
      if (unvisitedNeighbors.length > 0) {
        const chosen = unvisitedNeighbors[Math.floor(Math.random() * unvisitedNeighbors.length)];
        this.removeWallBetween(current, chosen);
        chosen.visited = true;
        current = chosen;
      } else {
        // Hunt phase: scan grid for unvisited cell adjacent to visited cell
        current = null;
        for (const cell of this.cells) {
          if (cell.visited) continue;
          const visitedNeighbors = cell.adj.filter((n) => n.visited);
          if (visitedNeighbors.length > 0) {
            const neighbor = visitedNeighbors[Math.floor(Math.random() * visitedNeighbors.length)];
            this.removeWallBetween(cell, neighbor);
            cell.visited = true;
            current = cell;
            break;
          }
        }
      }
    }

    this.resetCellVisited();
  }

  /**
   * Wilson's Algorithm: start random walks from unvisited cells, erase any loops they
   * make, and attach each finished walk to the maze. Every spanning tree is equally
   * likely, so there is no directional bias.
   */
  generateWilson() {
    const cells = this.cells;
    const N = cells.length;
    const inTree = new Uint8Array(N);
    const next = new Int32Array(N).fill(-1);

    const order = cells.map((c) => c.index);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    inTree[order[0]] = 1;
    for (let k = 1; k < N; k++) {
      let i = order[k];
      if (inTree[i]) continue;

      // Random walk until it touches the tree; overwriting next[] erases loops
      let at = i;
      while (!inTree[at]) {
        const adj = cells[at].adj;
        const step = adj[Math.floor(Math.random() * adj.length)].index;
        next[at] = step;
        at = step;
      }

      // Carve the loop-erased path
      at = i;
      while (!inTree[at]) {
        inTree[at] = 1;
        this.removeWallBetween(cells[at], cells[next[at]]);
        at = next[at];
      }
    }
  }

  /**
   * Aldous-Broder Algorithm: a plain random walk that carves whenever it steps onto a
   * cell it has not seen. Unbiased like Wilson's, but slow to finish, which makes the
   * generation animation wander before it fills the corners.
   */
  generateAldousBroder() {
    let current = this.randomCell();
    current.visited = true;
    let remaining = this.cells.length - 1;

    while (remaining > 0) {
      const next = current.adj[Math.floor(Math.random() * current.adj.length)];
      if (!next.visited) {
        this.removeWallBetween(current, next);
        next.visited = true;
        remaining--;
      }
      current = next;
    }

    this.resetCellVisited();
  }

  /**
   * Growing Tree: keep a list of active cells and carve out of either the newest one
   * (backtracker-like corridors) or a random one (Prim-like branching). Mixing the two
   * gives winding passages with plenty of side branches.
   */
  generateGrowingTree(newestBias = 0.5) {
    const active = [];
    const first = this.randomCell();
    first.visited = true;
    active.push(first);

    while (active.length > 0) {
      const idx = Math.random() < newestBias ? active.length - 1 : Math.floor(Math.random() * active.length);
      const cell = active[idx];
      const open = cell.adj.filter((n) => !n.visited);

      if (open.length === 0) {
        active[idx] = active[active.length - 1];
        active.pop();
        continue;
      }
      const chosen = open[Math.floor(Math.random() * open.length)];
      this.removeWallBetween(cell, chosen);
      chosen.visited = true;
      active.push(chosen);
    }

    this.resetCellVisited();
  }

  /**
   * Binary Tree: every cell links to one random neighbour that is closer to the corner
   * cell (by grid distance). On squares that is the classic north-or-west rule, which
   * leaves two long open edges; on hexagons and triangles it gives the same kind of
   * diagonal grain. Every cell except the corner has such a neighbour, so it always
   * connects.
   */
  generateBinaryTree() {
    const level = new Int32Array(this.cells.length).fill(-1);
    const queue = [this.cells[0]];
    level[0] = 0;
    for (let head = 0; head < queue.length; head++) {
      for (const n of queue[head].adj) {
        if (level[n.index] < 0) {
          level[n.index] = level[queue[head].index] + 1;
          queue.push(n);
        }
      }
    }

    for (const cell of this.cells) {
      const closer = cell.adj.filter((n) => level[n.index] < level[cell.index]);
      if (closer.length > 0) {
        this.removeWallBetween(cell, closer[Math.floor(Math.random() * closer.length)]);
      }
    }
  }

  /**
   * Braiding removes dead ends by knocking down walls, creating alternate routes.
   * braidFactor: fraction of dead ends to open (0.0 to 0.4)
   */
  applyBraid(factor = 0.1) {
    const deadEnds = this.cells.filter((cell) => this.getPassableNeighbors(cell).length === 1);

    for (const cell of deadEnds) {
      if (Math.random() < factor) {
        // Find closed walls that connect to another cell
        const closed = [];
        for (let d = 0; d < cell.walls.length; d++) {
          if (cell.walls[d] && cell.nbrs[d]) closed.push(cell.nbrs[d]);
        }
        if (closed.length > 0) {
          this.removeWallBetween(cell, closed[Math.floor(Math.random() * closed.length)]);
        }
      }
    }
  }

  resetCellVisited() {
    for (const cell of this.cells) cell.visited = false;
  }

  /**
   * Finds the two furthest points in the maze (topological diameter)
   * via double BFS. Guarantees dramatic, long race tracks!
   */
  computeLongestPathEndpoints() {
    // 1st BFS from an arbitrary point (e.g. 0,0) to find the most distant point A
    const furthestA = this.bfsFarthest(this.getCell(0, 0));

    // 2nd BFS from A to find the furthest point B
    const furthestB = this.bfsFarthest(furthestA.cell);

    this.start = { col: furthestA.cell.col, row: furthestA.cell.row };
    this.exit = { col: furthestB.cell.col, row: furthestB.cell.row };
    this.diameterDistance = furthestB.dist;
  }

  bfsFarthest(startCell) {
    const dist = new Int32Array(this.cells.length).fill(-1);
    const queue = [startCell];
    dist[startCell.index] = 0;
    let farthest = { cell: startCell, dist: 0 };

    for (let head = 0; head < queue.length; head++) {
      const cell = queue[head];
      const d = dist[cell.index];
      if (d > farthest.dist) farthest = { cell, dist: d };
      for (const n of this.getPassableNeighbors(cell)) {
        if (dist[n.index] < 0) {
          dist[n.index] = d + 1;
          queue.push(n);
        }
      }
    }

    return farthest;
  }
}

// Export for ES modules or browser global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Maze, MazeCell, TERRAINS, BIOMES, GENERATOR_IDS };
} else {
  window.Maze = Maze;
  window.MazeCell = MazeCell;
  window.TERRAINS = TERRAINS;
  window.BIOMES = BIOMES;
  window.GENERATOR_IDS = GENERATOR_IDS;
}
