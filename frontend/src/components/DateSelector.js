/**
 * DateSelector Component
 * Date picker with seasonal shortcuts for simulating solar positions across the year.
 */

export class DateSelector {
  constructor(container, initialDate = '2026-06-21', onDateChange = () => {}) {
    this.container = container;
    this.currentDate = initialDate;
    this.onDateChange = onDateChange;
    this.render();
  }

  render() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'glass-panel date-selector-wrapper';
    this.wrapper.style.display = 'inline-flex';
    this.wrapper.style.alignItems = 'center';
    this.wrapper.style.padding = '4px 10px';
    this.wrapper.style.gap = '8px';

    this.wrapper.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-sun);">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="16" y1="2" x2="16" y2="6"></line>
        <line x1="8" y1="2" x2="8" y2="6"></line>
        <line x1="3" y1="10" x2="21" y2="10"></line>
      </svg>
      <input type="date" class="date-input" value="${this.currentDate}" style="background: transparent; border: none; font-size: 0.85rem; font-family: var(--font-mono); color: var(--text-primary); cursor: pointer;" />
      <select class="solstice-dropdown" style="background: rgba(30, 41, 59, 0.7); border: 1px solid var(--border-card); font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; color: var(--text-secondary); cursor: pointer;">
        <option value="">Presets...</option>
        <option value="2026-06-21">Summer Solstice (Jun 21)</option>
        <option value="2026-09-22">Fall Equinox (Sep 22)</option>
        <option value="2026-12-21">Winter Solstice (Dec 21)</option>
        <option value="2026-03-20">Spring Equinox (Mar 20)</option>
      </select>
    `;

    this.input = this.wrapper.querySelector('.date-input');
    this.dropdown = this.wrapper.querySelector('.solstice-dropdown');

    this.input.addEventListener('change', (e) => {
      this.setDate(e.target.value);
    });

    this.dropdown.addEventListener('change', (e) => {
      if (e.target.value) {
        this.input.value = e.target.value;
        this.setDate(e.target.value);
        this.dropdown.value = '';
      }
    });

    this.container.appendChild(this.wrapper);
  }

  setDate(newDate) {
    if (this.currentDate === newDate) return;
    this.currentDate = newDate;
    this.onDateChange(newDate);
  }

  getDate() {
    return this.currentDate;
  }
}
