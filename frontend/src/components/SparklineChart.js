/**
 * SparklineChart Component
 * SVG 24-hour solar power generation curve with synchronized timeline playhead and click-to-seek.
 */

export class SparklineChart {
  constructor(container, onSeek = () => {}) {
    this.container = container;
    this.onSeek = onSeek;
    this.timeseries = [];
    this.width = 280;
    this.height = 70;
    this.maxPowerKw = 1.0;
    this.currentIndex = 0;
    this.render();
  }

  render() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'sparkline-wrapper';
    this.wrapper.style.width = '100%';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.cursor = 'pointer';

    this.wrapper.innerHTML = `
      <svg class="sparkline-svg" viewBox="0 0 ${this.width} ${this.height}" style="width: 100%; height: ${this.height}px; display: block; overflow: visible;">
        <defs>
          <linearGradient id="powerGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <!-- Baseline -->
        <line x1="0" y1="${this.height - 4}" x2="${this.width}" y2="${this.height - 4}" stroke="rgba(255,255,255,0.1)" stroke-width="1" />
        <!-- Shaded Area -->
        <polygon class="chart-area" points="" fill="url(#powerGradient)" />
        <!-- Curve Line -->
        <polyline class="chart-line" points="" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <!-- Playhead -->
        <line class="playhead-line" x1="0" y1="0" x2="0" y2="${this.height}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="2,2" style="display: none;" />
        <circle class="playhead-dot" cx="0" cy="0" r="3.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1.5" style="display: none;" />
      </svg>
      <div style="display: flex; justify-content: space-between; font-size: 0.65rem; font-family: var(--font-mono); color: var(--text-muted); margin-top: 2px;">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
      </div>
    `;

    this.svg = this.wrapper.querySelector('.sparkline-svg');
    this.area = this.wrapper.querySelector('.chart-area');
    this.line = this.wrapper.querySelector('.chart-line');
    this.playheadLine = this.wrapper.querySelector('.playhead-line');
    this.playheadDot = this.wrapper.querySelector('.playhead-dot');

    this.svg.addEventListener('click', (e) => {
      if (this.timeseries.length === 0) return;
      const rect = this.svg.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetIndex = Math.round(pct * (this.timeseries.length - 1));
      this.onSeek(targetIndex);
    });

    this.container.appendChild(this.wrapper);
  }

  setData(timeseries, scaleFactor = 1.0) {
    this.timeseries = timeseries || [];
    if (this.timeseries.length === 0) {
      this.line.setAttribute('points', '');
      this.area.setAttribute('points', '');
      this.playheadLine.style.display = 'none';
      this.playheadDot.style.display = 'none';
      return;
    }

    const powers = this.timeseries.map(d => d.power_kw * scaleFactor);
    this.maxPowerKw = Math.max(1.0, ...powers);

    const padTop = 6;
    const padBottom = 6;
    const usableH = this.height - padTop - padBottom;
    const n = this.timeseries.length;

    const points = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * this.width;
      const normY = powers[i] / this.maxPowerKw;
      const y = this.height - padBottom - (normY * usableH);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }

    const linePointsStr = points.join(' ');
    this.line.setAttribute('points', linePointsStr);

    // Area points: start bottom-left, follow line, end bottom-right
    const areaPointsStr = `0,${this.height - 4} ${linePointsStr} ${this.width},${this.height - 4}`;
    this.area.setAttribute('points', areaPointsStr);

    this.playheadLine.style.display = 'block';
    this.playheadDot.style.display = 'block';
    this.setPlayhead(this.currentIndex, scaleFactor);
  }

  setPlayhead(stepIndex, scaleFactor = 1.0) {
    if (this.timeseries.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(stepIndex, this.timeseries.length - 1));
    const n = this.timeseries.length;

    const x = (this.currentIndex / (n - 1)) * this.width;
    const power = (this.timeseries[this.currentIndex].power_kw || 0) * scaleFactor;
    const normY = power / this.maxPowerKw;
    const padTop = 6;
    const padBottom = 6;
    const usableH = this.height - padTop - padBottom;
    const y = this.height - padBottom - (normY * usableH);

    this.playheadLine.setAttribute('x1', x.toFixed(1));
    this.playheadLine.setAttribute('x2', x.toFixed(1));
    this.playheadDot.setAttribute('cx', x.toFixed(1));
    this.playheadDot.setAttribute('cy', y.toFixed(1));
  }
}
