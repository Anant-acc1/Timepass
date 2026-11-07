/**
 * Maze Solving Algorithms Suite - Enhanced with Rich Bi-Directional Algorithms
 * Supports both Bi-Directional and Uni-Directional pathfinding solvers.
 * Tracks temporal birth times, vector branches, and collision nodes for smooth city-grow animations.
 */

// Simple Min-Priority Queue for heuristic & uniform-cost searches
class PriorityQueue {
  constructor() {
    this.items = [];
  }
  enqueue(item, priority) {
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.items[mid].priority < priority) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.items.splice(low, 0, { item, priority });
  }
  dequeue() {
    return this.items.shift()?.item;
  }
  isEmpty() {
    return this.items.length === 0;
  }
}

class MazeSolver {
  constructor(maze, start, exit, config) {
    this.maze = maze;
    this.start = start;
    this.exit = exit;
    this.id = config.id;
    this.name = config.name;
    this.color = config.color;
    this.rgb = config.rgb; // [r, g, b]
    this.backwardColor = config.backwardColor || config.color;
    this.backwardRgb = config.backwardRgb || config.rgb;
    this.isBidirectional = !!config.isBidirectional;

    this.status = 'running'; // 'running', 'finished', 'trapped'
    this.stepsTaken = 0;
    this.visited = new Map(); // key -> { cell, parent, dir, birthTime, side, order }
    this.forwardVisited = new Map();
    this.backwardVisited = new Map();
    this.frontier = [];
    this.forwardFrontier = [];
    this.backwardFrontier = [];
    this.path = [];
    this.rank = null;
    this.meetingCell = null;
    this.collisionTime = null;
    this.stepOrder = 0;
    this.records = []; // every visit in growth order (renderer draws roads from this)
  }

  key(col, row) {
    return `${col},${row}`;
  }

  isExit(cell) {
    return cell.col === this.exit.col && cell.row === this.exit.row;
  }

  getDirection(p1, p2) {
    if (!p1 || !p2) return { dx: 0, dy: 0 };
    return { dx: p2.col - p1.col, dy: p2.row - p1.row };
  }

  recordVisited(cell, parent, side = 'forward') {
    const k = this.key(cell.col, cell.row);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const dir = this.getDirection(parent, cell);
    const record = {
      cell,
      parent,
      dir,
      birthTime: now,
      side,
      order: ++this.stepOrder
    };

    this.visited.set(k, record);
    this.records.push(record);
    if (side === 'forward') {
      this.forwardVisited.set(k, record);
    } else {
      this.backwardVisited.set(k, record);
    }
    return record;
  }

  reconstructPath(endCell) {
    const path = [];
    let curr = endCell;
    while (curr) {
      path.push(curr);
      const record = this.visited.get(this.key(curr.col, curr.row));
      curr = record ? record.parent : null;
    }
    this.path = path.reverse();
  }

  reconstructBidirectionalPath(meetingCell) {
    this.meetingCell = meetingCell;
    this.collisionTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const meetKey = this.key(meetingCell.col, meetingCell.row);

    // 1. Path from start to meeting cell
    const pathForward = [];
    let curr = meetingCell;
    while (curr) {
      pathForward.push(curr);
      const rec = this.forwardVisited.get(this.key(curr.col, curr.row));
      curr = rec ? rec.parent : null;
    }
    pathForward.reverse();

    // 2. Path from meeting cell to exit
    const pathBackward = [];
    curr = this.backwardVisited.get(meetKey)?.parent;
    while (curr) {
      pathBackward.push(curr);
      const rec = this.backwardVisited.get(this.key(curr.col, curr.row));
      curr = rec ? rec.parent : null;
    }

    this.path = [...pathForward, ...pathBackward];
  }

  step() {
    // Override in subclass
    return this.status;
  }
}

/* ============================================================
   BI-DIRECTIONAL ALGORITHMS SUITE (6 Solvers)
   ============================================================ */

/**
 * 1. Bidirectional A* (Bi-A*)
 * Forward heuristic: distance to Exit; Backward heuristic: distance to Start.
 */
class BidirectionalAStarSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'biastar',
      name: 'Bidirectional A*',
      color: '#05ffa1',
      rgb: [5, 255, 161],
      backwardColor: '#00e5ff',
      backwardRgb: [0, 229, 255],
      isBidirectional: true
    });

    this.forwardPQ = new PriorityQueue();
    this.backwardPQ = new PriorityQueue();
    this.forwardG = new Map();
    this.backwardG = new Map();

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);
    const sKey = this.key(start.col, start.row);
    const eKey = this.key(exit.col, exit.row);

    this.forwardG.set(sKey, 0);
    this.backwardG.set(eKey, 0);

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardPQ.enqueue(sCell, this.hForward(sCell));
    this.backwardPQ.enqueue(eCell, this.hBackward(eCell));

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  hForward(cell) {
    return Math.abs(cell.col - this.exit.col) + Math.abs(cell.row - this.exit.row);
  }

  hBackward(cell) {
    return Math.abs(cell.col - this.start.col) + Math.abs(cell.row - this.start.row);
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardPQ.isEmpty() || this.backwardPQ.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    // Expand Forward
    const currF = this.forwardPQ.dequeue();
    this.stepsTaken++;
    const currFKey = this.key(currF.col, currF.row);
    const currFG = this.forwardG.get(currFKey) || 0;

    const neighborsF = this.maze.getPassableNeighbors(currF);
    for (const n of neighborsF) {
      const nKey = this.key(n.col, n.row);
      const tentG = currFG + 1;
      if (this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.forwardG.has(nKey) || tentG < this.forwardG.get(nKey)) {
        this.forwardG.set(nKey, tentG);
        this.recordVisited(n, currF, 'forward');
        const fScore = tentG + this.hForward(n) * 1.001;
        this.forwardPQ.enqueue(n, fScore);
      }
    }

    // Expand Backward
    const currB = this.backwardPQ.dequeue();
    this.stepsTaken++;
    const currBKey = this.key(currB.col, currB.row);
    const currBG = this.backwardG.get(currBKey) || 0;

    const neighborsB = this.maze.getPassableNeighbors(currB);
    for (const n of neighborsB) {
      const nKey = this.key(n.col, n.row);
      const tentG = currBG + 1;
      if (this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.backwardG.has(nKey) || tentG < this.backwardG.get(nKey)) {
        this.backwardG.set(nKey, tentG);
        this.recordVisited(n, currB, 'backward');
        const fScore = tentG + this.hBackward(n) * 1.001;
        this.backwardPQ.enqueue(n, fScore);
      }
    }

    this.forwardFrontier = this.forwardPQ.items.slice(0, 8).map(i => i.item);
    this.backwardFrontier = this.backwardPQ.items.slice(0, 8).map(i => i.item);
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/**
 * 2. Bidirectional Breadth-First Search (Bi-BFS)
 * Radial uniform wavefronts from both Start and Exit
 */
class BidirectionalBFSSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'bibfs',
      name: 'Bidirectional BFS',
      color: '#38bdf8',
      rgb: [56, 189, 248],
      backwardColor: '#818cf8',
      backwardRgb: [129, 140, 248],
      isBidirectional: true
    });

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);

    this.forwardQueue = [sCell];
    this.backwardQueue = [eCell];

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardQueue.length === 0 || this.backwardQueue.length === 0) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    // Expand Forward
    const currF = this.forwardQueue.shift();
    this.stepsTaken++;
    const neighborsF = this.maze.getPassableNeighbors(currF);
    for (const n of neighborsF) {
      const nKey = this.key(n.col, n.row);
      if (this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.forwardQueue.push(n);
      }
    }

    // Expand Backward
    const currB = this.backwardQueue.shift();
    this.stepsTaken++;
    const neighborsB = this.maze.getPassableNeighbors(currB);
    for (const n of neighborsB) {
      const nKey = this.key(n.col, n.row);
      if (this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.backwardQueue.push(n);
      }
    }

    this.forwardFrontier = this.forwardQueue.slice(0, 10);
    this.backwardFrontier = this.backwardQueue.slice(0, 10);
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/**
 * 3. Bidirectional Greedy Best-First (Bi-Greedy)
 * Aggressively shoots directly toward opposite portal coordinates. Fast & dramatic!
 */
class BidirectionalGreedySolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'bigreedy',
      name: 'Bidirectional Greedy',
      color: '#ffb703',
      rgb: [255, 183, 3],
      backwardColor: '#ff5400',
      backwardRgb: [255, 84, 0],
      isBidirectional: true
    });

    this.forwardPQ = new PriorityQueue();
    this.backwardPQ = new PriorityQueue();

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardPQ.enqueue(sCell, this.hForward(sCell));
    this.backwardPQ.enqueue(eCell, this.hBackward(eCell));

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  hForward(cell) {
    return Math.hypot(cell.col - this.exit.col, cell.row - this.exit.row);
  }

  hBackward(cell) {
    return Math.hypot(cell.col - this.start.col, cell.row - this.start.row);
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardPQ.isEmpty() || this.backwardPQ.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const currF = this.forwardPQ.dequeue();
    this.stepsTaken++;
    for (const n of this.maze.getPassableNeighbors(currF)) {
      const nKey = this.key(n.col, n.row);
      if (this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.forwardPQ.enqueue(n, this.hForward(n));
      }
    }

    const currB = this.backwardPQ.dequeue();
    this.stepsTaken++;
    for (const n of this.maze.getPassableNeighbors(currB)) {
      const nKey = this.key(n.col, n.row);
      if (this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.backwardPQ.enqueue(n, this.hBackward(n));
      }
    }

    this.forwardFrontier = this.forwardPQ.items.slice(0, 8).map(i => i.item);
    this.backwardFrontier = this.backwardPQ.items.slice(0, 8).map(i => i.item);
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/**
 * 4. Bidirectional Dijkstra (Uniform Cost)
 * Guarantees optimal path with expanding circular collision wavefront
 */
class BidirectionalDijkstraSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'bidijkstra',
      name: 'Bidirectional Dijkstra',
      color: '#c084fc',
      rgb: [192, 132, 252],
      backwardColor: '#f43f5e',
      backwardRgb: [244, 63, 94],
      isBidirectional: true
    });

    this.forwardPQ = new PriorityQueue();
    this.backwardPQ = new PriorityQueue();
    this.forwardDist = new Map();
    this.backwardDist = new Map();

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);
    const sKey = this.key(start.col, start.row);
    const eKey = this.key(exit.col, exit.row);

    this.forwardDist.set(sKey, 0);
    this.backwardDist.set(eKey, 0);

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardPQ.enqueue(sCell, 0);
    this.backwardPQ.enqueue(eCell, 0);

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardPQ.isEmpty() || this.backwardPQ.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const currF = this.forwardPQ.dequeue();
    this.stepsTaken++;
    const currFDist = this.forwardDist.get(this.key(currF.col, currF.row)) || 0;

    for (const n of this.maze.getPassableNeighbors(currF)) {
      const nKey = this.key(n.col, n.row);
      const newDist = currFDist + 1;
      if (this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.forwardDist.has(nKey) || newDist < this.forwardDist.get(nKey)) {
        this.forwardDist.set(nKey, newDist);
        this.recordVisited(n, currF, 'forward');
        this.forwardPQ.enqueue(n, newDist);
      }
    }

    const currB = this.backwardPQ.dequeue();
    this.stepsTaken++;
    const currBDist = this.backwardDist.get(this.key(currB.col, currB.row)) || 0;

    for (const n of this.maze.getPassableNeighbors(currB)) {
      const nKey = this.key(n.col, n.row);
      const newDist = currBDist + 1;
      if (this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.backwardDist.has(nKey) || newDist < this.backwardDist.get(nKey)) {
        this.backwardDist.set(nKey, newDist);
        this.recordVisited(n, currB, 'backward');
        this.backwardPQ.enqueue(n, newDist);
      }
    }

    this.forwardFrontier = this.forwardPQ.items.slice(0, 8).map(i => i.item);
    this.backwardFrontier = this.backwardPQ.items.slice(0, 8).map(i => i.item);
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/**
 * 5. Bidirectional Depth-First Search (Bi-DFS)
 * Two deep exploratory tendrils snaking through corridors until their branches touch!
 */
class BidirectionalDFSSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'bidfs',
      name: 'Bidirectional DFS',
      color: '#ff3366',
      rgb: [255, 51, 102],
      backwardColor: '#fb7185',
      backwardRgb: [251, 113, 133],
      isBidirectional: true
    });

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);

    this.forwardStack = [sCell];
    this.backwardStack = [eCell];

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardStack.length === 0 || this.backwardStack.length === 0) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    // Forward DFS step
    const currF = this.forwardStack.pop();
    this.stepsTaken++;
    const unvisitedF = this.maze.getPassableNeighbors(currF).filter(
      n => !this.forwardVisited.has(this.key(n.col, n.row))
    );
    for (let i = unvisitedF.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unvisitedF[i], unvisitedF[j]] = [unvisitedF[j], unvisitedF[i]];
    }
    for (const n of unvisitedF) {
      const nKey = this.key(n.col, n.row);
      this.recordVisited(n, currF, 'forward');
      if (this.backwardVisited.has(nKey)) {
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      this.forwardStack.push(n);
    }

    // Backward DFS step
    const currB = this.backwardStack.pop();
    this.stepsTaken++;
    const unvisitedB = this.maze.getPassableNeighbors(currB).filter(
      n => !this.backwardVisited.has(this.key(n.col, n.row))
    );
    for (let i = unvisitedB.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unvisitedB[i], unvisitedB[j]] = [unvisitedB[j], unvisitedB[i]];
    }
    for (const n of unvisitedB) {
      const nKey = this.key(n.col, n.row);
      this.recordVisited(n, currB, 'backward');
      if (this.forwardVisited.has(nKey)) {
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      this.backwardStack.push(n);
    }

    this.forwardFrontier = this.forwardStack.length > 0 ? [this.forwardStack[this.forwardStack.length - 1]] : [];
    this.backwardFrontier = this.backwardStack.length > 0 ? [this.backwardStack[this.backwardStack.length - 1]] : [];
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/**
 * 6. Bidirectional Swarm (Dynamic Front-to-Front Magnetism)
 * Dynamically homes in on the opposing frontier's active centroid!
 */
class BidirectionalSwarmSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'biswarm',
      name: 'Bidirectional Swarm',
      color: '#06d6a0',
      rgb: [6, 214, 160],
      backwardColor: '#00b4d8',
      backwardRgb: [0, 180, 216],
      isBidirectional: true
    });

    this.forwardPQ = new PriorityQueue();
    this.backwardPQ = new PriorityQueue();

    const sCell = maze.getCell(start.col, start.row);
    const eCell = maze.getCell(exit.col, exit.row);

    this.recordVisited(sCell, null, 'forward');
    this.recordVisited(eCell, null, 'backward');

    this.forwardCentroid = { col: start.col, row: start.row };
    this.backwardCentroid = { col: exit.col, row: exit.row };

    this.forwardPQ.enqueue(sCell, 0);
    this.backwardPQ.enqueue(eCell, 0);

    this.forwardFrontier = [sCell];
    this.backwardFrontier = [eCell];
    this.frontier = [sCell, eCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.forwardPQ.isEmpty() || this.backwardPQ.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const currF = this.forwardPQ.dequeue();
    this.stepsTaken++;
    for (const n of this.maze.getPassableNeighbors(currF)) {
      const nKey = this.key(n.col, n.row);
      if (this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currF, 'forward');
        const distToBack = Math.hypot(n.col - this.backwardCentroid.col, n.row - this.backwardCentroid.row);
        this.forwardPQ.enqueue(n, distToBack);
        this.forwardCentroid = {
          col: (this.forwardCentroid.col + n.col) / 2,
          row: (this.forwardCentroid.row + n.row) / 2
        };
      }
    }

    const currB = this.backwardPQ.dequeue();
    this.stepsTaken++;
    for (const n of this.maze.getPassableNeighbors(currB)) {
      const nKey = this.key(n.col, n.row);
      if (this.forwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        this.reconstructBidirectionalPath(n);
        this.status = 'finished';
        this.frontier = [n];
        return this.status;
      }
      if (!this.backwardVisited.has(nKey)) {
        this.recordVisited(n, currB, 'backward');
        const distToFwd = Math.hypot(n.col - this.forwardCentroid.col, n.row - this.forwardCentroid.row);
        this.backwardPQ.enqueue(n, distToFwd);
        this.backwardCentroid = {
          col: (this.backwardCentroid.col + n.col) / 2,
          row: (this.backwardCentroid.row + n.row) / 2
        };
      }
    }

    this.forwardFrontier = this.forwardPQ.items.slice(0, 8).map(i => i.item);
    this.backwardFrontier = this.backwardPQ.items.slice(0, 8).map(i => i.item);
    this.frontier = [...this.forwardFrontier, ...this.backwardFrontier];
    return this.status;
  }
}

/* ============================================================
   UNI-DIRECTIONAL ALGORITHMS SUITE (6 Classic Solvers)
   ============================================================ */

/**
 * 7. A* Search (Manhattan Heuristic)
 */
class AStarSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'astar',
      name: 'A* Search',
      color: '#00ff88',
      rgb: [0, 255, 136]
    });

    this.pq = new PriorityQueue();
    this.gScore = new Map();

    const startCell = maze.getCell(start.col, start.row);
    const startKey = this.key(start.col, start.row);
    this.gScore.set(startKey, 0);
    this.recordVisited(startCell, null, 'forward');
    this.pq.enqueue(startCell, this.heuristic(startCell));
    this.frontier = [startCell];
  }

  heuristic(cell) {
    return Math.abs(cell.col - this.exit.col) + Math.abs(cell.row - this.exit.row);
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.pq.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const current = this.pq.dequeue();
    this.stepsTaken++;

    if (this.isExit(current)) {
      this.status = 'finished';
      this.reconstructPath(current);
      this.frontier = [current];
      return this.status;
    }

    const currKey = this.key(current.col, current.row);
    const currentG = this.gScore.get(currKey) || 0;

    const neighbors = this.maze.getPassableNeighbors(current);
    for (const n of neighbors) {
      const nKey = this.key(n.col, n.row);
      const tentativeG = currentG + 1;

      if (!this.gScore.has(nKey) || tentativeG < this.gScore.get(nKey)) {
        this.gScore.set(nKey, tentativeG);
        this.recordVisited(n, current, 'forward');
        const fScore = tentativeG + this.heuristic(n) * 1.001;
        this.pq.enqueue(n, fScore);
      }
    }

    this.frontier = this.pq.items.slice(0, 15).map(item => item.item);
    return this.status;
  }
}

/**
 * 8. Breadth-First Search (BFS)
 */
class BFSSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'bfs',
      name: 'Breadth-First (BFS)',
      color: '#00f0ff',
      rgb: [0, 240, 255]
    });

    const startCell = maze.getCell(start.col, start.row);
    this.queue = [startCell];
    this.recordVisited(startCell, null, 'forward');
    this.frontier = [startCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.queue.length === 0) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const current = this.queue.shift();
    this.stepsTaken++;

    if (this.isExit(current)) {
      this.status = 'finished';
      this.reconstructPath(current);
      this.frontier = [current];
      return this.status;
    }

    const neighbors = this.maze.getPassableNeighbors(current);
    for (const n of neighbors) {
      const nKey = this.key(n.col, n.row);
      if (!this.visited.has(nKey)) {
        this.recordVisited(n, current, 'forward');
        this.queue.push(n);
      }
    }

    this.frontier = this.queue.slice(0, 20);
    return this.status;
  }
}

/**
 * 9. Depth-First Search (DFS)
 */
class DFSSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'dfs',
      name: 'Depth-First (DFS)',
      color: '#ff3366',
      rgb: [255, 51, 102]
    });

    const startCell = maze.getCell(start.col, start.row);
    this.stack = [startCell];
    this.recordVisited(startCell, null, 'forward');
    this.frontier = [startCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.stack.length === 0) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const current = this.stack.pop();
    this.stepsTaken++;

    if (this.isExit(current)) {
      this.status = 'finished';
      this.reconstructPath(current);
      this.frontier = [current];
      return this.status;
    }

    const neighbors = this.maze.getPassableNeighbors(current);
    const unvisited = neighbors.filter(n => !this.visited.has(this.key(n.col, n.row)));

    for (let i = unvisited.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unvisited[i], unvisited[j]] = [unvisited[j], unvisited[i]];
    }

    for (const n of unvisited) {
      this.recordVisited(n, current, 'forward');
      this.stack.push(n);
    }

    this.frontier = this.stack.length > 0 ? [this.stack[this.stack.length - 1]] : [];
    return this.status;
  }
}

/**
 * 10. Greedy Best-First Search
 */
class GreedySolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'greedy',
      name: 'Greedy Best-First',
      color: '#ffb703',
      rgb: [255, 183, 3]
    });

    this.pq = new PriorityQueue();
    const startCell = maze.getCell(start.col, start.row);
    this.recordVisited(startCell, null, 'forward');
    this.pq.enqueue(startCell, this.heuristic(startCell));
    this.frontier = [startCell];
  }

  heuristic(cell) {
    return Math.hypot(cell.col - this.exit.col, cell.row - this.exit.row);
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.pq.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const current = this.pq.dequeue();
    this.stepsTaken++;

    if (this.isExit(current)) {
      this.status = 'finished';
      this.reconstructPath(current);
      this.frontier = [current];
      return this.status;
    }

    const neighbors = this.maze.getPassableNeighbors(current);
    for (const n of neighbors) {
      const nKey = this.key(n.col, n.row);
      if (!this.visited.has(nKey)) {
        this.recordVisited(n, current, 'forward');
        this.pq.enqueue(n, this.heuristic(n));
      }
    }

    this.frontier = this.pq.items.slice(0, 10).map(item => item.item);
    return this.status;
  }
}

/**
 * 11. Dijkstra's Algorithm (Uniform Cost)
 */
class DijkstraSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'dijkstra',
      name: "Dijkstra's",
      color: '#a855f7',
      rgb: [168, 85, 247]
    });

    this.pq = new PriorityQueue();
    this.dist = new Map();
    const startCell = maze.getCell(start.col, start.row);
    const startKey = this.key(start.col, start.row);
    this.dist.set(startKey, 0);
    this.recordVisited(startCell, null, 'forward');
    this.pq.enqueue(startCell, 0);
    this.frontier = [startCell];
  }

  step() {
    if (this.status !== 'running') return this.status;
    if (this.pq.isEmpty()) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const current = this.pq.dequeue();
    this.stepsTaken++;

    if (this.isExit(current)) {
      this.status = 'finished';
      this.reconstructPath(current);
      this.frontier = [current];
      return this.status;
    }

    const currKey = this.key(current.col, current.row);
    const currDist = this.dist.get(currKey) || 0;

    const neighbors = this.maze.getPassableNeighbors(current);
    for (const n of neighbors) {
      const nKey = this.key(n.col, n.row);
      const newDist = currDist + 1;
      if (!this.dist.has(nKey) || newDist < this.dist.get(nKey)) {
        this.dist.set(nKey, newDist);
        this.recordVisited(n, current, 'forward');
        this.pq.enqueue(n, newDist);
      }
    }

    this.frontier = this.pq.items.slice(0, 15).map(item => item.item);
    return this.status;
  }
}

/**
 * 12. Wall Follower (Right-Hand Rule)
 */
class WallFollowerSolver extends MazeSolver {
  constructor(maze, start, exit) {
    super(maze, start, exit, {
      id: 'wallfollower',
      name: 'Wall Follower (Right Hand)',
      color: '#ec4899',
      rgb: [236, 72, 153]
    });

    this.current = maze.getCell(start.col, start.row);
    this.facing = 'right';
    this.recordVisited(this.current, null, 'forward');
    this.frontier = [this.current];
    this.maxSteps = maze.cols * maze.rows * 5;
    this.agentTrail = [this.current];
  }

  getTurnRight(dir) {
    const order = ['up', 'right', 'down', 'left'];
    return order[(order.indexOf(dir) + 1) % 4];
  }

  getTurnLeft(dir) {
    const order = ['up', 'right', 'down', 'left'];
    return order[(order.indexOf(dir) + 3) % 4];
  }

  canMove(cell, dir) {
    if (dir === 'up') return !cell.walls.top;
    if (dir === 'right') return !cell.walls.right;
    if (dir === 'down') return !cell.walls.bottom;
    if (dir === 'left') return !cell.walls.left;
    return false;
  }

  getNextCell(cell, dir) {
    if (dir === 'up') return this.maze.getCell(cell.col, cell.row - 1);
    if (dir === 'right') return this.maze.getCell(cell.col + 1, cell.row);
    if (dir === 'down') return this.maze.getCell(cell.col, cell.row + 1);
    if (dir === 'left') return this.maze.getCell(cell.col - 1, cell.row);
    return null;
  }

  step() {
    if (this.status !== 'running') return this.status;
    this.stepsTaken++;

    if (this.isExit(this.current)) {
      this.status = 'finished';
      this.path = this.agentTrail;
      this.frontier = [this.current];
      return this.status;
    }

    if (this.stepsTaken > this.maxSteps) {
      this.status = 'trapped';
      this.frontier = [];
      return this.status;
    }

    const rightDir = this.getTurnRight(this.facing);
    const straightDir = this.facing;
    const leftDir = this.getTurnLeft(this.facing);
    const backDir = this.getTurnRight(rightDir);

    const candidates = [rightDir, straightDir, leftDir, backDir];

    for (const dir of candidates) {
      if (this.canMove(this.current, dir)) {
        const nextCell = this.getNextCell(this.current, dir);
        if (nextCell) {
          const prev = this.current;
          this.facing = dir;
          this.current = nextCell;
          const k = this.key(nextCell.col, nextCell.row);
          if (!this.visited.has(k)) {
            this.recordVisited(nextCell, prev, 'forward');
          }
          this.agentTrail.push(nextCell);
          break;
        }
      }
    }

    this.frontier = [this.current];
    return this.status;
  }
}

// Registry mapping algorithm IDs to their solver classes
const ALGORITHM_REGISTRY = {
  // Bi-directional
  biastar: BidirectionalAStarSolver,
  bibfs: BidirectionalBFSSolver,
  bigreedy: BidirectionalGreedySolver,
  bidijkstra: BidirectionalDijkstraSolver,
  bidfs: BidirectionalDFSSolver,
  biswarm: BidirectionalSwarmSolver,

  // Uni-directional
  astar: AStarSolver,
  bfs: BFSSolver,
  greedy: GreedySolver,
  dijkstra: DijkstraSolver,
  dfs: DFSSolver,
  wallfollower: WallFollowerSolver
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MazeSolver,
    PriorityQueue,
    BidirectionalAStarSolver,
    BidirectionalBFSSolver,
    BidirectionalGreedySolver,
    BidirectionalDijkstraSolver,
    BidirectionalDFSSolver,
    BidirectionalSwarmSolver,
    AStarSolver,
    BFSSolver,
    DFSSolver,
    GreedySolver,
    DijkstraSolver,
    WallFollowerSolver,
    ALGORITHM_REGISTRY
  };
} else {
  window.ALGORITHM_REGISTRY = ALGORITHM_REGISTRY;
  window.MazeSolver = MazeSolver;
}
