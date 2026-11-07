/**
 * Application Controller & State Orchestrator
 * Coordinates CityGrow procedural generation, multi-solver races,
 * and a capped-rate render loop.
 */

const RENDER_INTERVAL_MS = 1000 / 30 - 4; // small slack so 60 Hz rAF timing still yields ~30 fps

class MazeApp {
  constructor() {
    this.canvas = document.getElementById('maze-canvas');
    this.renderer = new MazeRenderer(this.canvas);

    // Configuration
    this.config = {
      mazeAlgo: 'spacefill',
      cols: 39,
      rows: 23,
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
    this.state = 'idle'; // 'racing', 'cooldown'
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
        this.renderer.computeLayout(this.maze.cols, this.maze.rows);
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

    // Maze Density / Preset
    const sizeSelect = document.getElementById('maze-size-select');
    if (sizeSelect) {
      sizeSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'small') {
          this.config.cols = 25;
          this.config.rows = 15;
        } else if (val === 'medium') {
          this.config.cols = 39;
          this.config.rows = 23;
        } else if (val === 'large') {
          this.config.cols = 55;
          this.config.rows = 33;
        } else if (val === 'dense') {
          this.config.cols = 75;
          this.config.rows = 43;
        }
        this.startNewRound();
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

  startNewRound() {
    this.roundNumber++;

    // 1. Procedurally generate maze
    this.maze = new Maze(this.config.cols, this.config.rows);
    this.maze.generate(this.config.mazeAlgo, this.config.braidFactor);
    this.renderer.computeLayout(this.maze.cols, this.maze.rows);

    // 2. Spawn configured solvers
    this.spawnSolvers();

    // 3. Update HUD
    this.updateRoundStats();
    this.state = 'racing';
    this.cooldownTimer = 0;
    this.postWinGraceSteps = 0;
    this.stepAccumulator = 0;

    const banner = document.getElementById('round-status-banner');
    if (banner) banner.classList.remove('visible');
  }

  restartSameMaze() {
    if (!this.maze) {
      this.startNewRound();
      return;
    }
    this.spawnSolvers();
    this.renderer.resetRound(); // clear the previous race's city
    this.updateRoundStats();
    this.state = 'racing';
    this.cooldownTimer = 0;
    this.postWinGraceSteps = 0;
    this.stepAccumulator = 0;

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
    if (dimEl) dimEl.textContent = `${this.maze.cols} × ${this.maze.rows}`;

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
        </div>
      `;
      list.appendChild(item);

      // Cache the metric nodes so per-frame updates don't query the DOM
      s.ui = {
        vis: item.querySelector(`#vis-${s.id}`),
        path: item.querySelector(`#path-${s.id}`),
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
        if (ui.badge) {
          const medals = ['🥇 1st', '🥈 2nd', '🥉 3rd', '4th', '5th', '6th', '7th', '8th'];
          ui.badge.className = 'lb-badge status-won';
          ui.badge.textContent = medals[s.rank - 1] || `${s.rank}th`;
        }
        ui.done = true;
      } else if (s.status === 'trapped') {
        if (ui.badge) {
          ui.badge.className = 'lb-badge status-trapped';
          ui.badge.textContent = 'Trapped';
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
      if (this.state === 'racing') {
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
                  solver.rank = this.finishedSolvers.length;
                }
              }
            }

            if (!anyActive) break;
          }

          this.updateLeaderboardMetrics();
        }

        // Check if race should conclude
        if (this.finishedSolvers.length > 0) {
          this.postWinGraceSteps += maxStepsToTake;
          const allResolved = this.solvers.every((s) => s.status !== 'running');
          const maxWinners = Math.min(3, this.solvers.length);

          if (allResolved || this.finishedSolvers.length >= maxWinners || this.postWinGraceSteps > 180) {
            this.state = 'cooldown';
            this.cooldownTimer = this.config.loopDelay;
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
              ? `🏆 ${winner.name} won${collisionInfo}!`
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
