/**
 * DateSelector Component
 * Inline full calendar card with Solstice/Equinox preset dropdown and Today shortcut.
 */

export class DateSelector {
  constructor(container, initialDate = '2026-06-21', onDateChange = () => {}) {
    this.container = container;
    this.currentDate = initialDate; // YYYY-MM-DD
    this.onDateChange = onDateChange;

    // View state for the calendar
    const [y, m] = initialDate.split('-').map(Number);
    this.viewYear = y;
    this.viewMonth = m - 1; // 0-indexed

    this.render();
  }

  render() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'glass-panel date-selector-card';
    this.wrapper.style.padding = '12px 14px';
    this.wrapper.style.width = '280px';
    this.wrapper.style.boxSizing = 'border-box';
    this.wrapper.style.userSelect = 'none';
    this.wrapper.style.display = 'flex';
    this.wrapper.style.flexDirection = 'column';

    this.wrapper.innerHTML = `
      <div class="calendar-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
        <button class="glaze-nav-btn cal-prev-month" title="Previous Month" style="padding: 2px 8px; height: 26px;">‹</button>
        <span class="cal-month-year" style="font-weight: 700; font-size: 0.88rem; color: var(--text-primary);">June 2026</span>
        <button class="glaze-nav-btn cal-next-month" title="Next Month" style="padding: 2px 8px; height: 26px;">›</button>
      </div>

      <div class="calendar-weekdays" style="display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 0.7rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px;">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
      </div>

      <div class="calendar-days-grid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; text-align: center; font-size: 0.76rem;">
        <!-- Days populated dynamically -->
      </div>

      <div class="calendar-quick-actions" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-card); font-size: 0.72rem;">
        <button class="btn btn-sm cal-shortcut-today" style="font-size: 0.72rem; height: 28px; padding: 0 10px; flex-shrink: 0;">Today</button>
        <select class="solstice-dropdown sleek-presets-select" title="Astronomical Presets" style="height: 28px; flex: 1; min-width: 0; box-sizing: border-box; font-size: 0.74rem;">
          <option value="" disabled selected>Solstice &amp; Equinox...</option>
          <option value="2026-06-21">Summer Solstice (Jun 21)</option>
          <option value="2026-09-22">Fall Equinox (Sep 22)</option>
          <option value="2026-12-21">Winter Solstice (Dec 21)</option>
          <option value="2026-03-20">Spring Equinox (Mar 20)</option>
        </select>
      </div>
    `;

    this.dropdown = this.wrapper.querySelector('.solstice-dropdown');
    this.monthYearLabel = this.wrapper.querySelector('.cal-month-year');
    this.daysGrid = this.wrapper.querySelector('.calendar-days-grid');

    this.dropdown.addEventListener('change', (e) => {
      if (e.target.value) {
        this.setDate(e.target.value);
        this.dropdown.value = '';
      }
    });

    this.wrapper.querySelector('.cal-prev-month').addEventListener('click', (e) => {
      e.stopPropagation();
      this.shiftMonth(-1);
    });

    this.wrapper.querySelector('.cal-next-month').addEventListener('click', (e) => {
      e.stopPropagation();
      this.shiftMonth(1);
    });

    this.wrapper.querySelector('.cal-shortcut-today').addEventListener('click', (e) => {
      e.stopPropagation();
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      this.setDate(`${y}-${m}-${d}`);
    });

    this.renderCalendarDays();
    this.container.appendChild(this.wrapper);
  }

  shiftMonth(delta) {
    this.viewMonth += delta;
    if (this.viewMonth < 0) {
      this.viewMonth = 11;
      this.viewYear -= 1;
    } else if (this.viewMonth > 11) {
      this.viewMonth = 0;
      this.viewYear += 1;
    }
    this.renderCalendarDays();
  }

  renderCalendarDays() {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    this.monthYearLabel.textContent = `${monthNames[this.viewMonth]} ${this.viewYear}`;
    this.daysGrid.innerHTML = '';

    const firstDayIndex = new Date(this.viewYear, this.viewMonth, 1).getDay();
    const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();

    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.style.padding = '5px';
      this.daysGrid.appendChild(emptyCell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dayCell = document.createElement('button');
      dayCell.className = 'btn btn-sm cal-day-btn';
      dayCell.style.padding = '5px 0';
      dayCell.style.width = '100%';
      dayCell.style.borderRadius = '6px';
      dayCell.style.fontSize = '0.75rem';
      dayCell.style.fontFamily = 'var(--font-mono)';
      dayCell.textContent = day;

      const cellDateStr = `${this.viewYear}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      if (cellDateStr === this.currentDate) {
        dayCell.classList.add('active');
        dayCell.style.background = '#2563eb';
        dayCell.style.color = '#ffffff';
        dayCell.style.fontWeight = '700';
        dayCell.style.boxShadow = '0 0 10px rgba(37, 99, 235, 0.6)';
      } else {
        dayCell.style.background = 'transparent';
        dayCell.style.border = '1px solid transparent';
        dayCell.style.color = 'var(--text-primary)';
      }

      dayCell.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setDate(cellDateStr);
      });

      this.daysGrid.appendChild(dayCell);
    }
  }

  setDate(newDate, triggerCallback = true) {
    if (this.currentDate === newDate) return;
    this.currentDate = newDate;

    const [y, m] = newDate.split('-').map(Number);
    this.viewYear = y;
    this.viewMonth = m - 1;
    this.renderCalendarDays();

    if (triggerCallback) {
      this.onDateChange(newDate);
    }
  }

  getDate() {
    return this.currentDate;
  }
}
