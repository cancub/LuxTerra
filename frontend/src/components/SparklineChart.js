/**
 * SparklineChart Component
 * SVG 24-hour solar power generation curve with synchronized timeline playhead, click-to-seek,
 * clear-sky potential envelope comparison, and visual tree canopy shading loss area.
 */

export class SparklineChart {
  constructor(container, onSeek = () => {}) {
    this.container = container;
    this.onSeek = onSeek;
    this.timeseries = [];
    this.width = 280;
    this.height = 76;
    this.maxPowerKw = 1.0;
    this.currentIndex = 0;
    this.currentScaleFactor = 1.0;
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
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.55" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.05" />
          </linearGradient>
          <linearGradient id="canopyLossGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#10b981" stop-opacity="0.32" />
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.08" />
          </linearGradient>
        </defs>

        <!-- Baseline -->
        <line x1="0" y1="${this.height - 4}" x2="${this.width}" y2="${this.height - 4}" stroke="rgba(255,255,255,0.12)" stroke-width="1" />

        <!-- Tree Canopy Shading Loss Area (between Potential and Actual) -->
        <polygon class="canopy-loss-area" points="" fill="url(#canopyLossGradient)" style="display: none;" />

        <!-- Clear-Sky Potential Curve (Dashed Amber Reference) -->
        <polyline class="potential-line" points="" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3,2" stroke-opacity="0.65" style="display: none;" />

        <!-- Actual Generated Power Area -->
        <polygon class="chart-area" points="" fill="url(#powerGradient)" />

        <!-- Actual Generated Power Line -->
        <polyline class="chart-line" points="" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />

        <!-- Playhead Vertical Drop Line (linking potential to actual) -->
        <line class="playhead-drop-line" x1="0" y1="0" x2="0" y2="0" stroke="#10b981" stroke-width="1.5" stroke-dasharray="2,2" style="display: none;" />

        <!-- Playhead Line -->
        <line class="playhead-line" x1="0" y1="0" x2="0" y2="${this.height}" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="2,2" style="display: none;" />

        <!-- Playhead Potential Dot -->
        <circle class="playhead-potential-dot" cx="0" cy="0" r="2.5" fill="#f59e0b" stroke="#ffffff" stroke-width="1" style="display: none;" />

        <!-- Playhead Actual Dot -->
        <circle class="playhead-dot" cx="0" cy="0" r="3.5" fill="#38bdf8" stroke="#ffffff" stroke-width="1.5" style="display: none;" />
      </svg>

      <!-- Time Axis -->
      <div style="display: flex; justify-content: space-between; font-size: 0.64rem; font-family: var(--font-mono); color: var(--text-muted); margin-top: 2px;">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
      </div>

      <!-- Legend -->
      <div class="sparkline-legend" style="display: flex; align-items: center; justify-content: space-between; font-size: 0.62rem; font-family: var(--font-mono); color: var(--text-muted); margin-top: 3px; padding: 0 1px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="width: 8px; height: 2px; background: #38bdf8; display: inline-block;"></span>
          <span style="color: #38bdf8; font-weight: 600;">Generated AC</span>
        </span>
        <span class="legend-canopy" style="display: none; align-items: center; gap: 4px;">
          <span style="width: 8px; height: 8px; background: rgba(16, 185, 129, 0.35); border: 1px solid #10b981; border-radius: 2px; display: inline-block;"></span>
          <span style="color: #34d399; font-weight: 600;">Canopy Loss</span>
        </span>
        <span class="legend-potential" style="display: none; align-items: center; gap: 4px;">
          <span style="width: 8px; height: 2px; background: #f59e0b; border-bottom: 1px dashed #f59e0b; display: inline-block;"></span>
          <span style="color: #f59e0b; font-weight: 600;">Clear-Sky</span>
        </span>
      </div>
    `;

    this.svg = this.wrapper.querySelector('.sparkline-svg');
    this.area = this.wrapper.querySelector('.chart-area');
    this.line = this.wrapper.querySelector('.chart-line');
    this.potentialLine = this.wrapper.querySelector('.potential-line');
    this.canopyLossArea = this.wrapper.querySelector('.canopy-loss-area');
    this.playheadLine = this.wrapper.querySelector('.playhead-line');
    this.playheadDot = this.wrapper.querySelector('.playhead-dot');
    this.playheadPotentialDot = this.wrapper.querySelector('.playhead-potential-dot');
    this.playheadDropLine = this.wrapper.querySelector('.playhead-drop-line');
    this.legendCanopy = this.wrapper.querySelector('.legend-canopy');
    this.legendPotential = this.wrapper.querySelector('.legend-potential');

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
    this.currentScaleFactor = scaleFactor;

    if (this.timeseries.length === 0) {
      this.line.setAttribute('points', '');
      this.area.setAttribute('points', '');
      if (this.potentialLine) this.potentialLine.style.display = 'none';
      if (this.canopyLossArea) this.canopyLossArea.style.display = 'none';
      this.playheadLine.style.display = 'none';
      this.playheadDot.style.display = 'none';
      if (this.playheadPotentialDot) this.playheadPotentialDot.style.display = 'none';
      if (this.playheadDropLine) this.playheadDropLine.style.display = 'none';
      return;
    }

    const powers = this.timeseries.map((d) => (d.power_kw || 0.0) * scaleFactor);
    const potentials = this.timeseries.map((d) => {
      const rawPot = d.unshaded_power_kw !== undefined ? d.unshaded_power_kw : d.power_kw;
      return (rawPot || 0.0) * scaleFactor;
    });
    const canopyLosses = this.timeseries.map((d) => (d.canopy_loss_kw || 0.0) * scaleFactor);

    const hasCanopyLoss = canopyLosses.some((loss) => loss > 0.05);

    this.maxPowerKw = Math.max(1.0, ...potentials, ...powers);

    const padTop = 6;
    const padBottom = 6;
    const usableH = this.height - padTop - padBottom;
    const n = this.timeseries.length;

    const actualPoints = [];
    const canopyTopPoints = [];
    const potentialPoints = [];

    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * this.width;

      const normYActual = powers[i] / this.maxPowerKw;
      const yActual = this.height - padBottom - normYActual * usableH;
      actualPoints.push(`${x.toFixed(1)},${yActual.toFixed(1)}`);

      // Canopy top curve = actual power + canopy loss (canopy loss excluding geological shading)
      const canopyTopKw = Math.min(potentials[i], powers[i] + canopyLosses[i]);
      const normYCanopy = canopyTopKw / this.maxPowerKw;
      const yCanopy = this.height - padBottom - normYCanopy * usableH;
      canopyTopPoints.push(`${x.toFixed(1)},${yCanopy.toFixed(1)}`);

      const normYPot = potentials[i] / this.maxPowerKw;
      const yPot = this.height - padBottom - normYPot * usableH;
      potentialPoints.push(`${x.toFixed(1)},${yPot.toFixed(1)}`);
    }

    const actualLineStr = actualPoints.join(' ');
    this.line.setAttribute('points', actualLineStr);

    // Actual generation area
    const actualAreaStr = `0,${this.height - 4} ${actualLineStr} ${this.width},${this.height - 4}`;
    this.area.setAttribute('points', actualAreaStr);

    // Potential clear-sky line
    const potLineStr = potentialPoints.join(' ');
    if (this.potentialLine) {
      this.potentialLine.setAttribute('points', potLineStr);
      this.potentialLine.style.display = hasCanopyLoss ? 'block' : 'none';
    }

    // Canopy loss shaded area between canopy top and actual power (canopy - geological)
    if (this.canopyLossArea) {
      if (hasCanopyLoss) {
        // Canopy top forward + actual reversed
        const reversedActual = [...actualPoints].reverse().join(' ');
        const canopyTopLineStr = canopyTopPoints.join(' ');
        const lossAreaStr = `${canopyTopLineStr} ${reversedActual}`;
        this.canopyLossArea.setAttribute('points', lossAreaStr);
        this.canopyLossArea.style.display = 'block';
      } else {
        this.canopyLossArea.style.display = 'none';
      }
    }

    if (this.legendCanopy) {
      this.legendCanopy.style.display = hasCanopyLoss ? 'flex' : 'none';
    }
    if (this.legendPotential) {
      this.legendPotential.style.display = hasCanopyLoss ? 'flex' : 'none';
    }

    this.playheadLine.style.display = 'block';
    this.playheadDot.style.display = 'block';
    this.setPlayhead(this.currentIndex, scaleFactor);
  }

  setPlayhead(stepIndex, scaleFactor = 1.0) {
    if (this.timeseries.length === 0) return;
    this.currentIndex = Math.max(0, Math.min(stepIndex, this.timeseries.length - 1));
    this.currentScaleFactor = scaleFactor;
    const n = this.timeseries.length;

    const x = (this.currentIndex / (n - 1)) * this.width;
    const m = this.timeseries[this.currentIndex];
    const power = (m.power_kw || 0) * scaleFactor;
    const potential = ((m.unshaded_power_kw !== undefined ? m.unshaded_power_kw : m.power_kw) || 0) * scaleFactor;
    const canopyLoss = (m.canopy_loss_kw || 0) * scaleFactor;

    const padTop = 6;
    const padBottom = 6;
    const usableH = this.height - padTop - padBottom;

    const normY = power / this.maxPowerKw;
    const yActual = this.height - padBottom - normY * usableH;

    const normYPot = potential / this.maxPowerKw;
    const yPot = this.height - padBottom - normYPot * usableH;

    this.playheadLine.setAttribute('x1', x.toFixed(1));
    this.playheadLine.setAttribute('x2', x.toFixed(1));

    this.playheadDot.setAttribute('cx', x.toFixed(1));
    this.playheadDot.setAttribute('cy', yActual.toFixed(1));

    if (canopyLoss > 0.05 && this.playheadPotentialDot && this.playheadDropLine) {
      this.playheadPotentialDot.style.display = 'block';
      this.playheadPotentialDot.setAttribute('cx', x.toFixed(1));
      this.playheadPotentialDot.setAttribute('cy', yPot.toFixed(1));

      this.playheadDropLine.style.display = 'block';
      this.playheadDropLine.setAttribute('x1', x.toFixed(1));
      this.playheadDropLine.setAttribute('y1', yPot.toFixed(1));
      this.playheadDropLine.setAttribute('x2', x.toFixed(1));
      this.playheadDropLine.setAttribute('y2', yActual.toFixed(1));
    } else {
      if (this.playheadPotentialDot) this.playheadPotentialDot.style.display = 'none';
      if (this.playheadDropLine) this.playheadDropLine.style.display = 'none';
    }
  }
}
