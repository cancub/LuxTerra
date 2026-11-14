/**
 * TimeScrubber Component
 * 24-hour timeline scrubber slider with sunrise/sunset markers and instantaneous solar geometry readout.
 */

export class TimeScrubber {
  constructor(container, onTimeChange = () => {}) {
    this.container = container;
    this.onTimeChange = onTimeChange;
    this.timeseries = [];
    this.dailySummary = null;
    this.currentIndex = 0;
    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel timeline-panel';
    this.element.style.padding = '12px 18px';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '8px';
    this.element.style.width = '100%';
    this.element.style.maxWidth = '660px';
    this.element.style.boxSizing = 'border-box';

    this.element.innerHTML = `
      <div class="scrubber-power-curve-mount" id="scrubber-power-curve-mount" style="width: 100%;"></div>

      <div class="timeline-header" style="display: flex; align-items: center; justify-content: center; gap: 16px; font-size: 0.85rem;">
        <span class="time-readout" style="font-family: var(--font-mono); font-size: 1.15rem; font-weight: 700; color: var(--accent-sun);">12:00</span>
        <div class="playback-inline-mount" id="playback-controls-mount" style="display: inline-flex; align-items: center;"></div>
      </div>

      <div class="slider-container" style="position: relative; width: 100%; height: 16px; display: flex; align-items: center;">
        <div class="sky-gradient-track" style="position: absolute; left: 0; right: 0; height: 8px; border-radius: 4px; background: linear-gradient(to right, #090e17 0%, #1e1b4b 20%, #d97706 28%, #38bdf8 50%, #d97706 72%, #1e1b4b 80%, #090e17 100%); pointer-events: none; z-index: 1; box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);"></div>
        <input type="range" class="timeline-slider" min="0" max="1439" value="720" style="width: calc(100% + 18px); margin: 0 -9px; height: 16px; z-index: 2; cursor: pointer;" />
      </div>

      <div class="timeline-ticks" style="display: flex; justify-content: space-between; font-size: 0.72rem; font-family: var(--font-mono); color: var(--text-secondary); font-weight: 500;">
        <span>00:00</span>
        <span>04:00</span>
        <span>08:00</span>
        <span>12:00</span>
        <span>16:00</span>
        <span>20:00</span>
        <span>24:00</span>
      </div>
    `;

    this.powerCurveMount = this.element.querySelector('.scrubber-power-curve-mount');
    this.playbackMount = this.element.querySelector('.playback-inline-mount');
    this.timeReadout = this.element.querySelector('.time-readout');
    this.slider = this.element.querySelector('.timeline-slider');
    this.skyTrack = this.element.querySelector('.sky-gradient-track');

    this.slider.addEventListener('input', (e) => {
      this.currentIndex = parseInt(e.target.value, 10);
      this.updateDisplay();
      if (this.timeseries[this.currentIndex]) {
        this.onTimeChange(this.currentIndex, this.timeseries[this.currentIndex]);
      }
    });

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) {
        return; // Don't intercept when user is typing in an input
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        this.setStep(this.currentIndex + delta);
      }
    });

    this.container.appendChild(this.element);
  }

  getPowerCurveMount() {
    return this.powerCurveMount;
  }

  getPlaybackMount() {
    return this.playbackMount;
  }

  setTimeseries(timeseries, dailySummary) {
    this.timeseries = timeseries || [];
    this.dailySummary = dailySummary || null;

    if (this.timeseries.length === 0) {
      this.currentIndex = 0;
      this.slider.max = 0;
      this.slider.value = 0;
      this.timeReadout.textContent = '-- h --';
      return;
    }

    this.slider.max = this.timeseries.length - 1;
    
    // Position sunrise/sunset markers and compute soft sky gradient
    if (this.dailySummary && this.dailySummary.sunrise_time && this.dailySummary.sunset_time) {
      const sunriseDt = new Date(this.dailySummary.sunrise_time);
      const sunsetDt = new Date(this.dailySummary.sunset_time);

      const firstDt = new Date(this.timeseries[0].timestamp);
      const lastDt = new Date(this.timeseries[this.timeseries.length - 1].timestamp);
      const totalSpan = lastDt.getTime() - firstDt.getTime();

      if (totalSpan > 0 && this.skyTrack) {
        const sunrisePct = Math.max(0, Math.min(100, ((sunriseDt.getTime() - firstDt.getTime()) / totalSpan) * 100));
        const sunsetPct = Math.max(0, Math.min(100, ((sunsetDt.getTime() - firstDt.getTime()) / totalSpan) * 100));
        
        const dawnStart = Math.max(0, (sunrisePct - 7)).toFixed(1);
        const dawnPeak = sunrisePct.toFixed(1);
        const morningSky = Math.min(100, (sunrisePct + 6)).toFixed(1);
        const noonPct = ((sunrisePct + sunsetPct) / 2).toFixed(1);
        const afternoonSky = Math.max(0, (sunsetPct - 6)).toFixed(1);
        const duskPeak = sunsetPct.toFixed(1);
        const duskEnd = Math.min(100, (sunsetPct + 7)).toFixed(1);

        this.skyTrack.style.background = `linear-gradient(to right,
          #070b13 0%,
          #070b13 ${dawnStart}%,
          #b45309 ${dawnPeak}%,
          #0284c7 ${morningSky}%,
          #38bdf8 ${noonPct}%,
          #0284c7 ${afternoonSky}%,
          #b45309 ${duskPeak}%,
          #070b13 ${duskEnd}%,
          #070b13 100%
        )`;
      }
    }

    // Default to solar noon or middle daylight step
    const daylightIndices = this.timeseries
      .map((item, idx) => (item.is_daylight ? idx : -1))
      .filter(idx => idx !== -1);

    const midIndex = daylightIndices.length > 0
      ? daylightIndices[Math.floor(daylightIndices.length / 2)]
      : Math.floor(this.timeseries.length / 2);

    this.setStep(midIndex);
  }

  setStep(index) {
    if (index < 0 || index >= this.timeseries.length) return;
    this.currentIndex = index;
    this.slider.value = index;
    this.updateDisplay();
    if (this.timeseries[index]) {
      this.onTimeChange(index, this.timeseries[index]);
    }
  }

  updateDisplay() {
    const item = this.timeseries[this.currentIndex];
    if (!item) return;

    const dt = new Date(item.timestamp);
    this.timeReadout.textContent = new Intl.DateTimeFormat('fr-CA', {
      timeZone: 'America/Toronto',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(dt);
  }
}
