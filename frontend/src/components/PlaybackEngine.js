/**
 * PlaybackEngine Component
 * High-performance 60 FPS requestAnimationFrame playback loop with 5 min/s and 15 min/s speed presets.
 */

export class PlaybackEngine {
  constructor(container, onStep = () => {}) {
    this.container = container;
    this.onStep = onStep;

    this.isPlaying = false;
    this.speedPreset = 15; // 5 or 15 min/s
    this.stepMinutes = 5;
    this.totalSteps = 288;
    this.currentStep = 0;
    this.fractionalStep = 0;
    this.lastFrameTime = 0;
    this.rafId = null;

    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel playback-controls';
    this.element.style.display = 'inline-flex';
    this.element.style.alignItems = 'center';
    this.element.style.padding = '3px 8px';
    this.element.style.gap = '6px';

    this.element.innerHTML = `
      <button class="btn btn-sm btn-play" title="Play/Pause Simulation">
        <svg class="icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <svg class="icon-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display: none;">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
      </button>

      <div class="speed-toggle-group" style="display: inline-flex; gap: 3px;">
        <button class="btn btn-sm speed-btn ${this.speedPreset === 5 ? 'active' : ''}" data-speed="5">5 min/s</button>
        <button class="btn btn-sm speed-btn ${this.speedPreset === 15 ? 'active' : ''}" data-speed="15">15 min/s</button>
      </div>
    `;

    this.playBtn = this.element.querySelector('.btn-play');
    this.iconPlay = this.element.querySelector('.icon-play');
    this.iconPause = this.element.querySelector('.icon-pause');
    this.speedBtns = this.element.querySelectorAll('.speed-btn');

    this.playBtn.addEventListener('click', () => this.togglePlay());

    this.speedBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const speed = parseInt(e.currentTarget.dataset.speed, 10);
        this.setSpeed(speed);
      });
    });

    this.container.appendChild(this.element);
  }

  setSimulationContext(totalSteps, stepMinutes = 5) {
    this.totalSteps = totalSteps > 0 ? totalSteps : 288;
    this.stepMinutes = stepMinutes > 0 ? stepMinutes : 5;
  }

  setCurrentStep(stepIndex) {
    this.currentStep = stepIndex;
    this.fractionalStep = stepIndex;
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.iconPlay.style.display = 'none';
    this.iconPause.style.display = 'block';
    this.playBtn.classList.add('btn-primary');

    this.lastFrameTime = performance.now();
    this.fractionalStep = this.currentStep;

    const tick = (now) => {
      if (!this.isPlaying) return;

      const deltaSec = (now - this.lastFrameTime) / 1000.0;
      this.lastFrameTime = now;

      // Rate: speedPreset (sim minutes per real second) / stepMinutes (sim minutes per step)
      const stepsPerSec = this.speedPreset / this.stepMinutes;
      this.fractionalStep += deltaSec * stepsPerSec;

      if (this.fractionalStep >= this.totalSteps) {
        // Loop around smoothly
        this.fractionalStep = 0;
      }

      const nextStep = Math.floor(this.fractionalStep);
      if (nextStep !== this.currentStep) {
        this.currentStep = nextStep;
        this.onStep(this.currentStep);
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.iconPlay.style.display = 'block';
    this.iconPause.style.display = 'none';
    this.playBtn.classList.remove('btn-primary');

    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  setSpeed(speed) {
    this.speedPreset = speed;
    this.speedBtns.forEach(btn => {
      if (parseInt(btn.dataset.speed, 10) === speed) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
}
