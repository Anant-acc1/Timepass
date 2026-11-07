/**
 * Maze Generation & Data Structure Module
 * Supports multiple solvable generation algorithms:
 * - Recursive Backtracker (DFS) - Long, winding paths
 * - Randomized Prim's - Bushy, high branch factor
 * - Randomized Kruskal's - Uniform spanning tree
 * - Hunt and Kill - Organic mixed labyrinth
 * Plus optional braiding (adding cycles for multiple alternative paths)
 */

class MazeCell {
  constructor(col, row) {
    this.col = col;
    this.row = row;
    // Walls: Top, Right, Bottom, Left
    this.walls = { top: true, right: true, bottom: true, left: true };
    this.visited = false;
  }
}

class Maze {
  constructor(cols, rows) {
    this.cols = Math.max(5, cols);
    this.rows = Math.max(5, rows);
    this.grid = [];
    this.start = null;
    this.exit = null;
    this.generationProgress = 1.0;
    this.isGenerating = false;
    this.initGrid();
  }

  initGrid() {
    this.grid = [];
    for (let r = 0; r < this.rows; r++) {
      const row = [];
      for (let c = 0; c < this.cols; c++) {
        row.push(new MazeCell(c, r));
      }
      this.grid.push(row);
    }
    this.start = { col: 0, row: 0 };
    this.exit = { col: this.cols - 1, row: this.rows - 1 };
  }

  getCell(col, row) {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      return null;
    }
    return this.grid[row][col];
  }

  getNeighbors(cell) {
    const { col, row } = cell;
    const neighbors = [];
    const dirs = [
      { dir: 'top', c: col, r: row - 1, opp: 'bottom' },
      { dir: 'right', c: col + 1, r: row, opp: 'left' },
      { dir: 'bottom', c: col, r: row + 1, opp: 'top' },
      { dir: 'left', c: col - 1, r: row, opp: 'right' }
    ];

    for (const d of dirs) {
      const neighbor = this.getCell(d.c, d.r);
      if (neighbor) {
        neighbors.push({ cell: neighbor, dir: d.dir, opp: d.opp });
      }
    }
    return neighbors;
  }

  getPassableNeighbors(cell) {
    const { col, row, walls } = cell;
    const passable = [];
    if (!walls.top) {
      const n = this.getCell(col, row - 1);
      if (n) passable.push(n);
    }
    if (!walls.right) {
      const n = this.getCell(col + 1, row);
      if (n) passable.push(n);
    }
    if (!walls.bottom) {
      const n = this.getCell(col, row + 1);
      if (n) passable.push(n);
    }
    if (!walls.left) {
      const n = this.getCell(col - 1, row);
      if (n) passable.push(n);
    }
    return passable;
  }

  removeWallBetween(c1, c2) {
    const dc = c2.col - c1.col;
    const dr = c2.row - c1.row;

    if (dc === 1) {
      c1.walls.right = false;
      c2.walls.left = false;
    } else if (dc === -1) {
      c1.walls.left = false;
      c2.walls.right = false;
    } else if (dr === 1) {
      c1.walls.bottom = false;
      c2.walls.top = false;
    } else if (dr === -1) {
      c1.walls.top = false;
      c2.walls.bottom = false;
    }
  }

  /**
   * Generates a guaranteed solvable maze using selected algorithm
   */
  generate(algorithm = 'spacefill', braidFactor = 0.08) {
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

    // Analyze topological junctions for city plazas and roundabouts
    this.computeTopology();
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
    const cols = this.cols;
    const rows = this.rows;
    const N = cols * rows;

    // 1. Hilbert rank for each cell
    let side = 1;
    while (side < Math.max(cols, rows)) side *= 2;
    const hilbertKey = (x, y) => {
      let d = 0;
      for (let s = side / 2; s > 0; s /= 2) {
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
    const keys = [];
    for (let i = 0; i < N; i++) {
      keys.push({ i, k: hilbertKey(i % cols, Math.floor(i / cols)) });
    }
    keys.sort((a, b) => a.k - b.k);
    const rank = new Array(N);
    keys.forEach((e, r) => { rank[e.i] = r; });

    // 2. Biased Prim spanning tree
    const parent = new Array(N).fill(-1);
    const depth = new Array(N).fill(0);
    const inTree = new Array(N).fill(false);
    const spread = Math.max(4, N * 0.03);
    const idxOf = (c, r) => r * cols + c;
    const cellAt = (i) => this.grid[Math.floor(i / cols)][i % cols];
    const neighborIdx = (i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const out = [];
      if (c + 1 < cols) out.push(idxOf(c + 1, r));
      if (c - 1 >= 0) out.push(idxOf(c - 1, r));
      if (r + 1 < rows) out.push(idxOf(c, r + 1));
      if (r - 1 >= 0) out.push(idxOf(c, r - 1));
      return out;
    };

    const frontier = []; // entries: { to, from }
    const carve = (i, from) => {
      inTree[i] = true;
      if (from >= 0) {
        parent[i] = from;
        depth[i] = depth[from] + 1;
        this.removeWallBetween(cellAt(from), cellAt(i));
      }
      for (const n of neighborIdx(i)) {
        if (!inTree[n]) frontier.push({ to: n, from: i });
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
      const c = i % cols;
      const r = Math.floor(i / cols);
      const pairs = [];
      if (c + 1 < cols) pairs.push(idxOf(c + 1, r));
      if (r + 1 < rows) pairs.push(idxOf(c, r + 1));
      for (const j of pairs) {
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
        this.removeWallBetween(cellAt(e.a), cellAt(e.b));
      }
    }
  }

  computeTopology() {
    this.junctions = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.getCell(c, r);
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
  }

  /**
   * Recursive Backtracker (Depth-First Search)
   */
  generateRecursiveBacktracker() {
    const stack = [];
    const startCell = this.getCell(
      Math.floor(Math.random() * this.cols),
      Math.floor(Math.random() * this.rows)
    );

    startCell.visited = true;
    stack.push(startCell);

    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const neighbors = this.getNeighbors(current).filter(n => !n.cell.visited);

      if (neighbors.length > 0) {
        // Pick random unvisited neighbor
        const chosen = neighbors[Math.floor(Math.random() * neighbors.length)];
        this.removeWallBetween(current, chosen.cell);
        chosen.cell.visited = true;
        stack.push(chosen.cell);
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
    const startCell = this.getCell(
      Math.floor(Math.random() * this.cols),
      Math.floor(Math.random() * this.rows)
    );
    startCell.visited = true;

    // Add start cell's adjacent walls
    this.getNeighbors(startCell).forEach(n => {
      walls.push({ c1: startCell, c2: n.cell });
    });

    while (walls.length > 0) {
      const randomIndex = Math.floor(Math.random() * walls.length);
      const { c1, c2 } = walls.splice(randomIndex, 1)[0];

      if (!c2.visited) {
        c2.visited = true;
        this.removeWallBetween(c1, c2);

        this.getNeighbors(c2).forEach(n => {
          if (!n.cell.visited) {
            walls.push({ c1: c2, c2: n.cell });
          }
        });
      }
    }

    this.resetCellVisited();
  }

  /**
   * Randomized Kruskal's Algorithm with Disjoint Set Union (DSU)
   */
  generateKruskal() {
    const totalCells = this.cols * this.rows;
    const parent = new Int32Array(totalCells);
    for (let i = 0; i < totalCells; i++) parent[i] = i;

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

    const getIdx = (c, r) => r * this.cols + c;

    // Collect all internal walls
    const edges = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const c1 = this.getCell(c, r);
        if (c + 1 < this.cols) {
          edges.push({ c1, c2: this.getCell(c + 1, r) });
        }
        if (r + 1 < this.rows) {
          edges.push({ c1, c2: this.getCell(c, r + 1) });
        }
      }
    }

    // Shuffle edges (Fisher-Yates)
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [edges[i], edges[j]] = [edges[j], edges[i]];
    }

    for (const edge of edges) {
      const idx1 = getIdx(edge.c1.col, edge.c1.row);
      const idx2 = getIdx(edge.c2.col, edge.c2.row);

      if (union(idx1, idx2)) {
        this.removeWallBetween(edge.c1, edge.c2);
      }
    }

    this.resetCellVisited();
  }

  /**
   * Hunt and Kill Algorithm
   */
  generateHuntAndKill() {
    let current = this.getCell(
      Math.floor(Math.random() * this.cols),
      Math.floor(Math.random() * this.rows)
    );
    current.visited = true;

    while (current) {
      // Walk phase
      const unvisitedNeighbors = this.getNeighbors(current).filter(n => !n.cell.visited);
      if (unvisitedNeighbors.length > 0) {
        const chosen = unvisitedNeighbors[Math.floor(Math.random() * unvisitedNeighbors.length)];
        this.removeWallBetween(current, chosen.cell);
        chosen.cell.visited = true;
        current = chosen.cell;
      } else {
        // Hunt phase: scan grid for unvisited cell adjacent to visited cell
        current = null;
        outer: for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            const cell = this.getCell(c, r);
            if (!cell.visited) {
              const visitedNeighbors = this.getNeighbors(cell).filter(n => n.cell.visited);
              if (visitedNeighbors.length > 0) {
                const neighbor = visitedNeighbors[Math.floor(Math.random() * visitedNeighbors.length)];
                this.removeWallBetween(cell, neighbor.cell);
                cell.visited = true;
                current = cell;
                break outer;
              }
            }
          }
        }
      }
    }

    this.resetCellVisited();
  }

  /**
   * Braiding removes dead ends by knocking down walls, creating alternate routes.
   * braidFactor: fraction of dead ends to open (0.0 to 0.4)
   */
  applyBraid(factor = 0.1) {
    const deadEnds = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.getCell(c, r);
        const passages = this.getPassableNeighbors(cell);
        if (passages.length === 1) {
          deadEnds.push(cell);
        }
      }
    }

    for (const cell of deadEnds) {
      if (Math.random() < factor) {
        // Find closed walls that connect to another cell
        const closedNeighbors = this.getNeighbors(cell).filter(n => {
          const dc = n.cell.col - cell.col;
          const dr = n.cell.row - cell.row;
          if (dc === 1) return cell.walls.right;
          if (dc === -1) return cell.walls.left;
          if (dr === 1) return cell.walls.bottom;
          if (dr === -1) return cell.walls.top;
          return false;
        });

        if (closedNeighbors.length > 0) {
          const chosen = closedNeighbors[Math.floor(Math.random() * closedNeighbors.length)];
          this.removeWallBetween(cell, chosen.cell);
        }
      }
    }
  }

  resetCellVisited() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.grid[r][c].visited = false;
      }
    }
  }

  /**
   * Finds the two furthest points in the maze (topological diameter)
   * via double BFS. Guarantees dramatic, long race tracks!
   */
  computeLongestPathEndpoints() {
    // 1st BFS from an arbitrary point (e.g. 0,0) to find the most distant point A
    const firstPoint = this.getCell(0, 0);
    const furthestA = this.bfsFarthest(firstPoint);

    // 2nd BFS from A to find the furthest point B
    const furthestB = this.bfsFarthest(furthestA.cell);

    this.start = { col: furthestA.cell.col, row: furthestA.cell.row };
    this.exit = { col: furthestB.cell.col, row: furthestB.cell.row };
    this.diameterDistance = furthestB.dist;
  }

  bfsFarthest(startCell) {
    const queue = [{ cell: startCell, dist: 0 }];
    const visited = new Set();
    visited.add(`${startCell.col},${startCell.row}`);

    let farthest = { cell: startCell, dist: 0 };

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.dist > farthest.dist) {
        farthest = current;
      }

      const neighbors = this.getPassableNeighbors(current.cell);
      for (const n of neighbors) {
        const key = `${n.col},${n.row}`;
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({ cell: n, dist: current.dist + 1 });
        }
      }
    }

    return farthest;
  }
}

// Export for ES modules or browser global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Maze, MazeCell };
} else {
  window.Maze = Maze;
  window.MazeCell = MazeCell;
}
