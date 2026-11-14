/**
 * SparklineChart Component
 * SVG 24-hour solar power generation curve with synchronized timeline playhead, click-to-seek,
 * clear-sky potential envelope comparison, visual tree canopy shading loss area,
 * collapsible card header, and collapsible vertically-stacked legend in the top-right corner.
 */

export class SparklineChart {
  constructor(container, onSeek = () => {}) {
    this.container = container;
    this.onSeek = onSeek;
    this.timeseries = [];
    this.width = 520;
    this.height = 76;
    this.maxPowerKw = 1.0;
    this.currentIndex = 0;
    this.currentScaleFactor = 1.0;
    this.isCollapsed = false;
    this.isLegendCollapsed = false;
    this.hasCanopyLoss = false;
    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'power-curve-panel';
    this.element.style.width = '100%';
    this.element.style.boxSizing = 'border-box';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '4px';
    this.element.style.padding = '0 0 8px 0';
    this.element.style.marginBottom = '6px';
    this.element.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';

    this.element.innerHTML = `
      <!-- Collapsible Card Header -->
      <div class="power-curve-header" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;">
        <span style="font-weight: 700; font-size: 0.74rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-solar); flex-shrink: 0;">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          <span style="text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-size: 0.70rem;">24-Hour Power Curve</span>
        </span>
        <button class="curve-collapse-btn" title="Toggle 24-Hour Power Curve" style="background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border-card); border-radius: 4px; color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;">
          <svg class="curve-chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s ease;">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>
      </div>

      <!-- Collapsible Card Body -->
      <div class="power-curve-body" style="display: flex; flex-direction: column; width: 100%;">
        <div class="sparkline-wrapper" style="width: 100%; position: relative; cursor: pointer;">
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

          <!-- Collapsible Legend in Top-Right Corner (Vertically Stacked) -->
          <div class="sparkline-legend-box" style="position: absolute; top: 2px; right: 4px; z-index: 10; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px; padding: 3px 6px;">
            <div class="legend-header" style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; cursor: pointer; user-select: none;">
              <span style="font-size: 0.58rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;">Legend</span>
              <svg class="legend-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s ease;">
                <polyline points="18 15 12 9 6 15"></polyline>
              </svg>
            </div>
            <div class="legend-items" style="display: flex; flex-direction: column; gap: 3px; margin-top: 3px; font-size: 0.62rem; font-family: var(--font-mono);">
              <span style="display: flex; align-items: center; gap: 5px;">
                <span style="width: 8px; height: 2px; background: #38bdf8; display: inline-block;"></span>
                <span style="color: #38bdf8; font-weight: 600;">Generated AC</span>
              </span>
              <span class="legend-canopy" style="display: none; align-items: center; gap: 5px;">
                <span style="width: 8px; height: 8px; background: rgba(16, 185, 129, 0.35); border: 1px solid #10b981; border-radius: 2px; display: inline-block;"></span>
                <span style="color: #34d399; font-weight: 600;">Canopy Loss</span>
              </span>
              <span class="legend-selfshade" style="display: none; align-items: center; gap: 5px;">
                <span style="width: 8px; height: 8px; background: rgba(129, 140, 248, 0.35); border: 1px solid #818cf8; border-radius: 2px; display: inline-block;"></span>
                <span style="color: #a5b4fc; font-weight: 600;">Self-Shade</span>
              </span>
              <span class="legend-potential" style="display: none; align-items: center; gap: 5px;">
                <span style="width: 8px; height: 2px; background: #f59e0b; border-bottom: 1px dashed #f59e0b; display: inline-block;"></span>
                <span style="color: #f59e0b; font-weight: 600;">Clear-Sky</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.wrapper = this.element.querySelector('.sparkline-wrapper');
    this.curveHeader = this.element.querySelector('.power-curve-header');
    this.curveBody = this.element.querySelector('.power-curve-body');
    this.curveChevron = this.element.querySelector('.curve-chevron-icon');

    this.svg = this.element.querySelector('.sparkline-svg');
    this.area = this.element.querySelector('.chart-area');
    this.line = this.element.querySelector('.chart-line');
    this.potentialLine = this.element.querySelector('.potential-line');
    this.canopyLossArea = this.element.querySelector('.canopy-loss-area');
    this.playheadLine = this.element.querySelector('.playhead-line');
    this.playheadDot = this.element.querySelector('.playhead-dot');
    this.playheadPotentialDot = this.element.querySelector('.playhead-potential-dot');
    this.playheadDropLine = this.element.querySelector('.playhead-drop-line');

    this.legendHeader = this.element.querySelector('.legend-header');
    this.legendItems = this.element.querySelector('.legend-items');
    this.legendChevron = this.element.querySelector('.legend-chevron');
    this.legendCanopy = this.element.querySelector('.legend-canopy');
    this.legendSelfShade = this.element.querySelector('.legend-selfshade');
    this.legendPotential = this.element.querySelector('.legend-potential');

    this.curveHeader.addEventListener('click', () => {
      this.toggleCurveCollapse();
    });

    if (this.legendHeader) {
      this.legendHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleLegendCollapse();
      });
    }

    this.svg.addEventListener('click', (e) => {
      if (this.timeseries.length === 0) return;
      const rect = this.svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const targetIndex = Math.round(pct * (this.timeseries.length - 1));
      this.onSeek(targetIndex);
    });

    this.container.appendChild(this.element);
  }

  toggleCurveCollapse() {
    this.isCollapsed = !this.isCollapsed;
    if (this.curveBody) {
      this.curveBody.style.display = this.isCollapsed ? 'none' : 'flex';
    }
    if (this.curveChevron) {
      this.curveChevron.style.transform = this.isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  }

  toggleLegendCollapse() {
    this.isLegendCollapsed = !this.isLegendCollapsed;
    if (this.legendItems) {
      this.legendItems.style.display = this.isLegendCollapsed ? 'none' : 'flex';
    }
    if (this.legendChevron) {
      this.legendChevron.style.transform = this.isLegendCollapsed ? 'rotate(180deg)' : 'rotate(0deg)';
    }
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
    const selfLosses = this.timeseries.map((d) => (d.self_shading_loss_kw || 0.0) * scaleFactor);

    this.hasCanopyLoss = canopyLosses.some((loss) => loss > 0.05);
    this.hasSelfShadeLoss = selfLosses.some((loss) => loss > 0.05);
    const hasAnyLoss = this.hasCanopyLoss || this.hasSelfShadeLoss;

    this.maxPowerKw = Math.max(1.0, ...potentials, ...powers);

    const padTop = 6;
    const padBottom = 6;
    const usableH = this.height - padTop - padBottom;
    const n = this.timeseries.length;

    const actualPoints = [];
    const canopyTopPoints = [];
    const potentialPoints = [];

    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, n - 1)) * this.width;

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
      this.potentialLine.style.display = hasAnyLoss ? 'block' : 'none';
    }

    // Canopy loss shaded area between canopy top and actual power (canopy - geological)
    if (this.canopyLossArea) {
      if (this.hasCanopyLoss) {
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
      this.legendCanopy.style.display = this.hasCanopyLoss ? 'flex' : 'none';
    }
    if (this.legendSelfShade) {
      this.legendSelfShade.style.display = this.hasSelfShadeLoss ? 'flex' : 'none';
    }
    if (this.legendPotential) {
      this.legendPotential.style.display = hasAnyLoss ? 'flex' : 'none';
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

    const x = (this.currentIndex / Math.max(1, n - 1)) * this.width;
    const m = this.timeseries[this.currentIndex];
    const power = (m.power_kw || 0) * scaleFactor;
    const potential = ((m.unshaded_power_kw !== undefined ? m.unshaded_power_kw : m.power_kw) || 0) * scaleFactor;
    const canopyLoss = (m.canopy_loss_kw || 0) * scaleFactor;
    const selfLoss = (m.self_shading_loss_kw || 0) * scaleFactor;

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

    if ((canopyLoss > 0.05 || selfLoss > 0.05) && this.playheadPotentialDot && this.playheadDropLine) {
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
