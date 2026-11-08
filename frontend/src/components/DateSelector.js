/**
 * DateSelector Component
 * Sleek custom dark glassmorphic date selector with:
 * - Direct date display button opening an interactive custom calendar popup
 * - Prev/Next single-day step buttons (‹ and ›)
 * - Astronomical seasonal preset shortcuts (Solstices & Equinoxes)
 */

export class DateSelector {
  constructor(container, initialDate = '2026-06-21', onDateChange = () => {}) {
    this.container = container;
    this.currentDate = initialDate; // YYYY-MM-DD
    this.onDateChange = onDateChange;
    this.isCalendarOpen = false;

    // View state for the calendar popup
    const [y, m, d] = initialDate.split('-').map(Number);
    this.viewYear = y;
    this.viewMonth = m - 1; // 0-indexed

    this.render();
  }

  render() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'glass-panel date-selector-wrapper';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.display = 'inline-flex';
    this.wrapper.style.alignItems = 'center';
    this.wrapper.style.padding = '3px 8px';
    this.wrapper.style.gap = '6px';
    this.wrapper.style.userSelect = 'none';

    this.wrapper.innerHTML = `
      <!-- Prev Day Button -->
      <button class="btn btn-sm date-step-btn prev-day-btn" title="Previous Day" style="padding: 4px 6px; border-radius: 4px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>

      <!-- Date Display Trigger -->
      <button class="btn btn-sm date-display-btn" title="Click to open calendar" style="display: flex; align-items: center; gap: 7px; padding: 4px 10px; font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600; background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(255, 255, 255, 0.2);">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-sun);">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="16" y1="2" x2="16" y2="6"></line>
          <line x1="8" y1="2" x2="8" y2="6"></line>
          <line x1="3" y1="10" x2="21" y2="10"></line>
        </svg>
        <span class="formatted-date-label">${this.formatDateDisplay(this.currentDate)}</span>
      </button>

      <!-- Next Day Button -->
      <button class="btn btn-sm date-step-btn next-day-btn" title="Next Day" style="padding: 4px 6px; border-radius: 4px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>

      <!-- Solstice Presets Dropdown -->
      <select class="solstice-dropdown sleek-presets-select" title="Astronomical Presets" style="margin-left: 2px;">
        <option value="" disabled selected>Solstice & Equinox...</option>
        <option value="2026-06-21">Summer Solstice (Jun 21)</option>
        <option value="2026-09-22">Fall Equinox (Sep 22)</option>
        <option value="2026-12-21">Winter Solstice (Dec 21)</option>
        <option value="2026-03-20">Spring Equinox (Mar 20)</option>
      </select>

      <!-- Custom Calendar Dropdown Popup -->
      <div class="glass-panel custom-calendar-popover" style="display: none; position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 1000; width: 280px; padding: 14px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6); border: 1px solid rgba(255, 255, 255, 0.18);">
        <div class="calendar-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
          <button class="btn btn-sm cal-prev-month" style="padding: 2px 7px;">‹</button>
          <span class="cal-month-year" style="font-weight: 700; font-size: 0.88rem; color: var(--text-primary);">June 2026</span>
          <button class="btn btn-sm cal-next-month" style="padding: 2px 7px;">›</button>
        </div>

        <div class="calendar-weekdays" style="display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 0.7rem; font-weight: 600; color: var(--text-muted); margin-bottom: 6px;">
          <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
        </div>

        <div class="calendar-days-grid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; font-size: 0.78rem;">
          <!-- Days populated dynamically -->
        </div>

        <div class="calendar-quick-actions" style="display: flex; justify-content: space-between; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border-card); font-size: 0.72rem;">
          <button class="btn btn-sm cal-shortcut-today" style="font-size: 0.72rem; padding: 3px 8px;">Today</button>
          <button class="btn btn-sm cal-shortcut-summer" style="font-size: 0.72rem; padding: 3px 8px; color: #fbbf24;">Solstice</button>
          <button class="btn btn-sm cal-close-btn" style="font-size: 0.72rem; padding: 3px 8px;">Close</button>
        </div>
      </div>
    `;

    this.dateDisplayBtn = this.wrapper.querySelector('.date-display-btn');
    this.dateLabel = this.wrapper.querySelector('.formatted-date-label');
    this.prevDayBtn = this.wrapper.querySelector('.prev-day-btn');
    this.nextDayBtn = this.wrapper.querySelector('.next-day-btn');
    this.dropdown = this.wrapper.querySelector('.solstice-dropdown');
    this.calendarPopup = this.wrapper.querySelector('.custom-calendar-popover');
    this.monthYearLabel = this.wrapper.querySelector('.cal-month-year');
    this.daysGrid = this.wrapper.querySelector('.calendar-days-grid');

    // Bind event listeners
    this.prevDayBtn.addEventListener('click', () => this.shiftDay(-1));
    this.nextDayBtn.addEventListener('click', () => this.shiftDay(1));

    this.dateDisplayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCalendar();
    });

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
      const today = new Date().toISOString().split('T')[0];
      this.setDate(today);
      this.closeCalendar();
    });

    this.wrapper.querySelector('.cal-shortcut-summer').addEventListener('click', (e) => {
      e.stopPropagation();
      this.setDate('2026-06-21');
      this.closeCalendar();
    });

    this.wrapper.querySelector('.cal-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeCalendar();
    });

    // Close calendar on outside click
    document.addEventListener('click', (e) => {
      if (this.isCalendarOpen && !this.calendarPopup.contains(e.target) && !this.dateDisplayBtn.contains(e.target)) {
        this.closeCalendar();
      }
    });

    this.container.appendChild(this.wrapper);
  }

  formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d);
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  toggleCalendar() {
    if (this.isCalendarOpen) {
      this.closeCalendar();
    } else {
      this.openCalendar();
    }
  }

  openCalendar() {
    const [y, m] = this.currentDate.split('-').map(Number);
    this.viewYear = y;
    this.viewMonth = m - 1;
    this.renderCalendarDays();
    this.calendarPopup.style.display = 'block';
    this.isCalendarOpen = true;
  }

  closeCalendar() {
    this.calendarPopup.style.display = 'none';
    this.isCalendarOpen = false;
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

  shiftDay(deltaDays) {
    const [y, m, d] = this.currentDate.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + deltaDays);
    const nextStr = date.toISOString().split('T')[0];
    this.setDate(nextStr);
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

    // Leading empty slots
    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.style.padding = '6px';
      this.daysGrid.appendChild(emptyCell);
    }

    // Month days
    for (let day = 1; day <= daysInMonth; day++) {
      const dayCell = document.createElement('button');
      dayCell.className = 'btn btn-sm cal-day-btn';
      dayCell.style.padding = '6px 0';
      dayCell.style.width = '100%';
      dayCell.style.borderRadius = '6px';
      dayCell.style.fontSize = '0.76rem';
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
        this.closeCalendar();
      });

      this.daysGrid.appendChild(dayCell);
    }
  }

  setDate(newDate) {
    if (this.currentDate === newDate) return;
    this.currentDate = newDate;
    this.dateLabel.textContent = this.formatDateDisplay(newDate);

    const [y, m] = newDate.split('-').map(Number);
    this.viewYear = y;
    this.viewMonth = m - 1;

    this.onDateChange(newDate);
  }

  getDate() {
    return this.currentDate;
  }
}
