/**
 * Application Controller & State Orchestrator
 * Coordinates CityGrow procedural generation, multi-solver races,
 * and a capped-rate render loop.
 */

const RENDER_INTERVAL_MS = 1000 / 30 - 4; // small slack so 60 Hz rAF timing still yields ~30 fps

// Grid size presets as a cell count (grid.js turns it into columns x rows for each shape)
const SIZE_PRESETS = { small: 375, medium: 897, large: 1815, dense: 3225 };
const RACE_GRACE_STEPS = 1500; // steps the others get to finish after the first solver reaches the exit
const GENERATOR_NAMES = {
  spacefill: 'Hilbert Spacefill',
  backtracker: 'Recursive Backtracker',
  prims: "Prim's",
  kruskal: "Kruskal's",
  huntandkill: 'Hunt and Kill',
  wilson: "Wilson's",
  aldousbroder: 'Aldous-Broder',
  growingtree: 'Growing Tree',
  binarytree: 'Binary Tree'
};
const GENERATION_SECONDS = 3.2; // replay length at 4x speed; scales inversely with the speed slider

class MazeApp {
  constructor() {
    this.canvas = document.getElementById('maze-canvas');
    this.renderer = new MazeRenderer(this.canvas);

    // Configuration
    this.config = {
      mazeAlgo: 'random',    // a generator id, or 'random' to pick one each round
      shape: 'square',      // 'square' | 'hexagon' | 'triangle'
      sizePreset: 'medium', // key of SIZE_PRESETS
      terrain: true,        // weighted terrain
      biome: 'random',      // 'desert' | 'tundra' | 'random' (picked each round)
      showGeneration: true, // animate the maze being carved
      braidFactor: 0.1,
      speed: 4, // Multiplier for simulation stepping speed
      autoLoop: true,
      loopDelay: 4.5, // Seconds after round ends before next maze
      activeAlgorithms: {
        // Bi-Directional Solvers (Featured!)
        biastar: true,
        bibfs: true,
        bigreedy: true,
        bidijkstra: false,
        bidfs: true,
        biswarm: true,

        // Classic Uni-Directional Solvers
        astar: false,
        bfs: false,
        greedy: false,
        dijkstra: false,
        dfs: false,
        wallfollower: false
      }
    };

    // State
    this.maze = null;
    this.solvers = [];
    this.finishedSolvers = [];
    this.isPaused = false;
    this.roundNumber = 0;
    this.state = 'idle'; // 'generating', 'racing', 'cooldown'
    this.genProgress = 0; // fraction of the carve events replayed so far
    this.cooldownTimer = 0;
    this.postWinGraceSteps = 0;
    this.lastFrameTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.lastRenderAt = -Infinity;
    this.stepAccumulator = 0;

    // UI idle fade
    this.idleTimer = null;

    this.initEventListeners();
    this.initUI();
    this.startNewRound();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  initEventListeners() {
    window.addEventListener('resize', () => {
      this.renderer.resize();
      if (this.maze) {
        this.renderTerrainLegend();
    this.renderer.computeLayout(this.maze);
      }
    });

    // Mouse movement reveals UI, fades out after 3.5s of inactivity
    const showUI = () => {
      document.body.classList.remove('idle-hide');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        document.body.classList.add('idle-hide');
      }, 3500);
    };

    window.addEventListener('mousemove', showUI);
    window.addEventListener('pointerdown', showUI);
    window.addEventListener('keydown', (e) => {
      showUI();
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePause();
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        this.startNewRound();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        this.toggleFullscreen();
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        document.body.classList.toggle('force-hide-ui');
      }
    });
  }

  initUI() {
    // Buttons
    document.getElementById('btn-new')?.addEventListener('click', () => this.startNewRound());
    document.getElementById('btn-restart')?.addEventListener('click', () => this.restartSameMaze());
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btn-settings')?.addEventListener('click', () => {
      document.getElementById('settings-panel')?.classList.toggle('open');
    });
    document.getElementById('btn-close-settings')?.addEventListener('click', () => {
      document.getElementById('settings-panel')?.classList.remove('open');
    });

    // Speed Slider
    const speedSlider = document.getElementById('speed-slider');
    const speedVal = document.getElementById('speed-value');
    if (speedSlider) {
      speedSlider.value = this.config.speed;
      speedSlider.addEventListener('input', (e) => {
        this.config.speed = parseInt(e.target.value, 10);
        if (speedVal) speedVal.textContent = `${this.config.speed}x`;
      });
    }

    // Maze Algorithm Selector
    const algoSelect = document.getElementById('maze-algo-select');
    if (algoSelect) {
      algoSelect.value = this.config.mazeAlgo;
      algoSelect.addEventListener('change', (e) => {
        this.config.mazeAlgo = e.target.value;
        this.startNewRound();
      });
    }

    // Grid shape (regular polygons that tile the plane)
    const shapeSelect = document.getElementById('grid-shape-select');
    if (shapeSelect) {
      shapeSelect.value = this.config.shape;
      shapeSelect.addEventListener('change', (e) => {
        this.config.shape = e.target.value;
        this.startNewRound();
      });
    }

    // Maze Density / Preset
    const sizeSelect = document.getElementById('maze-size-select');
    if (sizeSelect) {
      sizeSelect.value = this.config.sizePreset;
      sizeSelect.addEventListener('change', (e) => {
        this.config.sizePreset = e.target.value;
        this.startNewRound();
      });
    }

    // Weighted terrain
    const terrainChk = document.getElementById('chk-terrain');
    if (terrainChk) {
      terrainChk.checked = this.config.terrain;
      terrainChk.addEventListener('change', (e) => {
        this.config.terrain = e.target.checked;
        this.startNewRound();
      });
    }
    const biomeSelect = document.getElementById('biome-select');
    if (biomeSelect) {
      biomeSelect.value = this.config.biome;
      biomeSelect.addEventListener('change', (e) => {
        this.config.biome = e.target.value;
        this.renderTerrainLegend();
        this.startNewRound();
      });
    }
    this.renderTerrainLegend();

    // Generation animation
    const genChk = document.getElementById('chk-generation');
    if (genChk) {
      genChk.checked = this.config.showGeneration;
      genChk.addEventListener('change', (e) => {
        this.config.showGeneration = e.target.checked;
      });
    }

    // Braid Factor
    const braidSlider = document.getElementById('braid-slider');
    const braidVal = document.getElementById('braid-value');
    if (braidSlider) {
      braidSlider.value = this.config.braidFactor * 100;
      braidSlider.addEventListener('input', (e) => {
        this.config.braidFactor = parseInt(e.target.value, 10) / 100;
        if (braidVal) braidVal.textContent = `${Math.round(this.config.braidFactor * 100)}%`;
      });
    }

    // Algorithm Checkboxes (All 12 Solvers)
    const allAlgoKeys = Object.keys(this.config.activeAlgorithms);
    allAlgoKeys.forEach((id) => {
      const el = document.getElementById(`chk-${id}`);
      if (el) {
        el.checked = !!this.config.activeAlgorithms[id];
        el.addEventListener('change', (e) => {
          this.config.activeAlgorithms[id] = e.target.checked;
          this.restartSameMaze();
        });
      }
    });

    // Preset Quick-Select Buttons
    document.getElementById('btn-select-bi')?.addEventListener('click', () => {
      allAlgoKeys.forEach((id) => {
        const isBi = id.startsWith('bi');
        this.config.activeAlgorithms[id] = isBi;
        const el = document.getElementById(`chk-${id}`);
        if (el) el.checked = isBi;
      });
      this.restartSameMaze();
    });

    document.getElementById('btn-select-all')?.addEventListener('click', () => {
      allAlgoKeys.forEach((id) => {
        this.config.activeAlgorithms[id] = true;
        const el = document.getElementById(`chk-${id}`);
        if (el) el.checked = true;
      });
      this.restartSameMaze();
    });

    // Auto-loop toggle
    const loopChk = document.getElementById('chk-autoloop');
    if (loopChk) {
      loopChk.checked = this.config.autoLoop;
      loopChk.addEventListener('change', (e) => {
        this.config.autoLoop = e.target.checked;
      });
    }

    // Display GPU status badge in HUD
    this.updateGPUBadge();
  }

  /** Fills the settings drawer's terrain key from the chosen biome (colour swatch, name, cost). */
  renderTerrainLegend() {
    const el = document.getElementById('terrain-legend');
    if (!el) return;
    el.innerHTML = '';
    const shown = this.maze && this.maze.hasTerrain ? this.maze.biome : this.config.biome;
    for (const t of BIOMES[shown] || BIOMES.desert) {
      const item = document.createElement('span');
      item.className = 'terrain-key';
      item.innerHTML = `<i style="background:${t.tint}"></i>${t.name} <b>×${t.cost}</b>`;
      el.appendChild(item);
    }
  }

  /** Ranks the finished solvers by path cost (ties: fewer cells expanded) and ends the race. */
  finishRace() {
    this.finishedSolvers.sort((a, b) => {
      const dc = this.maze.pathCost(a.path) - this.maze.pathCost(b.path);
      return dc || a.visited.size - b.visited.size;
    });
    this.finishedSolvers.forEach((s, i) => { s.rank = i + 1; });
    for (const s of this.solvers) {
      if (s.status === 'running') { s.status = 'trapped'; s.calledOff = true; }
      if (s.ui) s.ui.done = false; // let the metrics pass repaint badges with their rank
    }
    this.updateLeaderboardMetrics();
    this.state = 'cooldown';
    this.cooldownTimer = this.config.loopDelay;
  }

  updateGPUBadge() {
    const gpuEl = document.getElementById('stat-gpu');
    if (gpuEl) {
      // The renderer draws with Canvas 2D (browser-composited on the GPU); WebGL is only probed
      gpuEl.textContent = 'Canvas 2D · layered';
      gpuEl.style.color = '#00ff88';
      gpuEl.title = 'Rendered with Canvas 2D';
    }
  }

  togglePause() {
    this.isPaused = !this.isPaused;
    const btn = document.getElementById('btn-pause');
    if (btn) {
      btn.innerHTML = this.isPaused
        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
      btn.title = this.isPaused ? 'Resume (Space)' : 'Pause (Space)';
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  /** Columns and rows for the current shape and size preset, filling the viewport's aspect. */
  currentGridSize() {
    const pad = Math.min(this.renderer.width, this.renderer.height) * 0.055 * 2;
    const aspect = Math.max(0.3, (this.renderer.width - pad) / Math.max(1, this.renderer.height - pad));
    return gridDimensions(this.config.shape, SIZE_PRESETS[this.config.sizePreset] || SIZE_PRESETS.medium, aspect);
  }

  startNewRound() {
    this.roundNumber++;

    // 1. Procedurally generate the maze on the chosen grid of regular polygons
    const { cols, rows } = this.currentGridSize();
    this.maze = new Maze(cols, rows, this.config.shape);
    this.maze.generate(this.config.mazeAlgo, this.config.braidFactor, { terrain: this.config.terrain, biome: this.config.biome });
    this.renderer.computeLayout(this.maze);

    // 2. Replay the carving (solvers join once the maze is complete), or go straight to the race
    this.solvers = [];
    this.finishedSolvers = [];
    this.eraseStarted = false;
    this.renderer.beginGeneration(this.maze, this.config.showGeneration);
    this.updateRoundStats();
    this.cooldownTimer = 0;
    this.postWinGraceSteps = 0;
    this.stepAccumulator = 0;
    this.genProgress = 0;

    const banner = document.getElementById('round-status-banner');
    if (this.config.showGeneration) {
      this.state = 'generating';
      this.renderLeaderboardUI();
      if (banner) {
        banner.textContent = `Carving maze · ${GENERATOR_NAMES[this.maze.algorithm] || this.maze.algorithm}${this.maze.hasTerrain ? ` · ${this.maze.biome}` : ''}`;
        banner.classList.add('visible');
      }
    } else {
      this.beginRace();
      if (banner) banner.classList.remove('visible');
    }
  }

  /** Called once the maze is fully carved: spawn the solvers and start the race. */
  beginRace() {
    this.renderer.generating = false;
    this.spawnSolvers();
    this.state = 'racing';
    this.stepAccumulator = 0;
  }

  restartSameMaze() {
    if (!this.maze) {
      this.startNewRound();
      return;
    }
    this.renderer.beginGeneration(this.maze, false); // show the finished maze
    this.renderer.resetRound(); // clear the previous race's city
    this.beginRace();
    this.updateRoundStats();
    this.cooldownTimer = 0;
    this.postWinGraceSteps = 0;

    const banner = document.getElementById('round-status-banner');
    if (banner) banner.classList.remove('visible');
  }

  spawnSolvers() {
    this.solvers = [];
    this.finishedSolvers = [];
    this.eraseStarted = false;

    const activeIds = Object.keys(this.config.activeAlgorithms).filter(
      (id) => this.config.activeAlgorithms[id]
    );

    // If none selected, default to Bidirectional A* and Bi-BFS
    if (activeIds.length === 0) {
      this.config.activeAlgorithms.biastar = true;
      this.config.activeAlgorithms.bibfs = true;
      activeIds.push('biastar', 'bibfs');
    }

    for (const id of activeIds) {
      const SolverClass = ALGORITHM_REGISTRY[id];
      if (SolverClass) {
        const solver = new SolverClass(this.maze, this.maze.start, this.maze.exit);
        this.solvers.push(solver);
      }
    }

    // Random colours for every race
    this.renderer.assignPalette(this.solvers);
    this.renderLeaderboardUI();
  }

  updateRoundStats() {
    const roundEl = document.getElementById('stat-round');
    if (roundEl) roundEl.textContent = `#${this.roundNumber}`;

    const dimEl = document.getElementById('stat-dimensions');
    if (dimEl) dimEl.textContent = `${this.maze.cols} × ${this.maze.rows} ${this.maze.geom.name}`;

    const distEl = document.getElementById('stat-distance');
    if (distEl) distEl.textContent = `${this.maze.diameterDistance || 'N/A'} cells`;
  }

  renderLeaderboardUI() {
    const list = document.getElementById('leaderboard-list');
    if (!list) return;

    list.innerHTML = '';
    this.solvers.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'leaderboard-item';
      item.id = `lb-${s.id}`;

      const biBadge = s.isBidirectional ? '<span class="bi-tag">⇄ BI</span>' : '';

      item.innerHTML = `
        <div class="lb-header">
          <span class="color-dot" style="background: ${s.color}; box-shadow: 0 0 8px ${s.color};"></span>
          <span class="lb-name">${s.name} ${biBadge}</span>
          <span class="lb-badge status-exploring" id="badge-${s.id}">Expanding</span>
        </div>
        <div class="lb-metrics">
          <span>Visited: <b id="vis-${s.id}">1</b></span>
          <span>Path: <b id="path-${s.id}">--</b></span>
          ${this.maze && this.maze.hasTerrain ? `<span>Cost: <b id="cost-${s.id}">--</b></span>` : ''}
        </div>
      `;
      list.appendChild(item);

      // Cache the metric nodes so per-frame updates don't query the DOM
      s.ui = {
        vis: item.querySelector(`#vis-${s.id}`),
        path: item.querySelector(`#path-${s.id}`),
        cost: item.querySelector(`#cost-${s.id}`),
        badge: item.querySelector(`#badge-${s.id}`),
        lastVis: -1,
        done: false
      };
    });
  }

  /** Writes leaderboard text only when a value actually changed. */
  updateLeaderboardMetrics() {
    for (const s of this.solvers) {
      const ui = s.ui;
      if (!ui || ui.done) continue;

      const vis = s.visited.size;
      if (vis !== ui.lastVis && ui.vis) {
        ui.vis.textContent = vis;
        ui.lastVis = vis;
      }

      if (s.status === 'finished') {
        if (ui.path) ui.path.textContent = `${s.path.length} steps`;
        // With terrain on, the cheapest route is not always the shortest, so show both
        if (ui.cost) ui.cost.textContent = this.maze.pathCost(s.path);
        if (ui.badge) {
          const medals = ['🥇 1st', '🥈 2nd', '🥉 3rd', '4th', '5th', '6th', '7th', '8th'];
          ui.badge.className = 'lb-badge status-won';
          // Ranks are only known once the race ends (the cheapest path wins, not the first home)
          ui.badge.textContent = s.rank ? medals[s.rank - 1] || `${s.rank}th` : 'Finished';
        }
        ui.done = true;
      } else if (s.status === 'trapped') {
        if (ui.badge) {
          ui.badge.className = 'lb-badge status-trapped';
          ui.badge.textContent = s.calledOff ? 'Stopped' : 'Trapped';
        }
        ui.done = true;
      }
    }
  }

  /**
   * Continuous CityGrow Simulation & Animation Loop
   */
  animate(now) {
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (!this.isPaused) {
      if (this.state === 'generating') {
        const total = this.renderer.totalEvents(this.maze);
        const seconds = Math.min(8, Math.max(0.8, (GENERATION_SECONDS * 4) / this.config.speed));
        this.genProgress = Math.min(1, this.genProgress + dt / seconds);
        this.renderer.setGenCount(Math.floor(this.genProgress * total));
        if (this.genProgress >= 1) {
          this.renderer.setGenCount(total);
          const banner = document.getElementById('round-status-banner');
          if (banner) banner.classList.remove('visible');
          this.beginRace();
        }
      } else if (this.state === 'racing') {
        // Steps per second scaled smoothly by speed multiplier
        const stepsPerSecond = this.config.speed * 16;
        this.stepAccumulator += dt * stepsPerSecond;

        const maxStepsToTake = Math.min(60, Math.floor(this.stepAccumulator));
        // Activity comes from solver state, not from whether a step ran this frame
        // (otherwise a frame with fewer than one step would end the round early)
        let anyActive = this.solvers.some((s) => s.status === 'running');

        if (maxStepsToTake >= 1) {
          for (let step = 0; step < maxStepsToTake; step++) {
            this.stepAccumulator -= 1.0;

            for (const solver of this.solvers) {
              if (solver.status === 'running') {
                anyActive = true;
                const status = solver.step();

                if (status === 'finished') {
                  this.finishedSolvers.push(solver);
                }
              }
            }

            if (!anyActive) break;
          }

          this.updateLeaderboardMetrics();
        }

        // The cheapest path wins, so wait for every solver to resolve. A solver still wandering
        // long after the first one home is called off (it cannot have been a contender).
        if (this.finishedSolvers.length > 0) {
          this.postWinGraceSteps += maxStepsToTake;
          const allResolved = this.solvers.every((s) => s.status !== 'running');
          if (allResolved || this.postWinGraceSteps > RACE_GRACE_STEPS) {
            this.finishRace();
          }
        } else if (!anyActive) {
          // All trapped
          this.state = 'cooldown';
          this.cooldownTimer = this.config.loopDelay;
        }
      } else if (this.state === 'cooldown') {
        if (this.config.autoLoop) {
          this.cooldownTimer -= dt;
          // Erase the finished city shortly before the next maze appears
          if (!this.eraseStarted && this.cooldownTimer <= this.renderer.eraseDuration + 0.2) {
            this.eraseStarted = true;
            this.renderer.startErase();
          }
          const statusText = document.getElementById('round-status-banner');
          if (statusText) {
            const winner = this.finishedSolvers[0];
            const collisionInfo = winner && winner.meetingCell
              ? ` (Met at [${winner.meetingCell.col}, ${winner.meetingCell.row}])`
              : '';
            const headline = winner
              ? `🏆 ${winner.name} won${collisionInfo}${winner ? ` with cost ${this.maze.pathCost(winner.path)}` : ''}!`
              : 'No solver reached the exit.';
            statusText.textContent = `${headline} Next labyrinth in ${Math.ceil(this.cooldownTimer)}s...`;
            statusText.classList.add('visible');
          }

          if (this.cooldownTimer <= 0) {
            if (statusText) statusText.classList.remove('visible');
            this.startNewRound();
          }
        }
      }
    }

    // Render at a capped cadence; the simulation above still steps every animation frame
    if (this.maze && now - this.lastRenderAt >= RENDER_INTERVAL_MS) {
      this.lastRenderAt = now;
      this.renderer.render(this.maze, this.solvers);
    }

    requestAnimationFrame(this.animate);
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.app = new MazeApp();
});
