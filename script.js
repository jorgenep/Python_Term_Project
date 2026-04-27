// ==========================================
//  CONFIG
// ==========================================
const POLL_MS     = 3000;
const DB_REFRESH  = 15000;
const EVENT_LIMIT = 50;

let PI_HOST   = 'localhost';
let PI_PORT   = '8080';
let DEMO_MODE = false;

// ==========================================
//  DEMO / MOCK DATA
// ==========================================
const MOCK_HOURLY = [0,0,0,0,0,0,2,5,12,20,28,25,22,18,21,26,24,18,12,8,4,2,1,0];
const MOCK_EVENTS = [
  { direction: 'entry', occupancy: 5,  timestamp: Date.now()/1000 - 90  },
  { direction: 'exit',  occupancy: 4,  timestamp: Date.now()/1000 - 210 },
  { direction: 'entry', occupancy: 6,  timestamp: Date.now()/1000 - 330 },
  { direction: 'entry', occupancy: 7,  timestamp: Date.now()/1000 - 450 },
  { direction: 'exit',  occupancy: 6,  timestamp: Date.now()/1000 - 600 },
  { direction: 'entry', occupancy: 8,  timestamp: Date.now()/1000 - 750 },
  { direction: 'exit',  occupancy: 7,  timestamp: Date.now()/1000 - 900 },
];

// ==========================================
//  STATE
// ==========================================
let peakCount        = 0;
let peakTime         = '--:--';
let occupancyHistory = new Array(24).fill(0);
let demoOccupancy    = 18;

// ==========================================
//  CLOCK
// ==========================================
function tickClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ==========================================
//  CONFIG MODAL
// ==========================================
function applyConfig(demo = false) {
  DEMO_MODE = demo;
  if (!demo) {
    PI_HOST = document.getElementById('pi-ip').value.trim()   || 'localhost';
    PI_PORT = document.getElementById('pi-port').value.trim() || '8080';
  }
  document.getElementById('modal-overlay').style.display = 'none';
  const urlEl = document.getElementById('pi-url-display');
  if (urlEl) urlEl.textContent = DEMO_MODE ? 'demo mode' : `${PI_HOST}:${PI_PORT}`;
  setConnected(DEMO_MODE ? 'demo' : null);
  init();
}

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('modal-overlay').style.display = 'flex';
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (!confirm('Reset occupancy count to 0?')) return;
  if (DEMO_MODE) { demoOccupancy = 0; updateOccupancyUI(0); return; }
  try {
    await fetch(`http://${PI_HOST}:${PI_PORT}/api/reset`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.error('Reset failed:', e);
  }
});

// ==========================================
//  CONNECTION STATUS
// ==========================================
function setConnected(state) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot || !label) return;
  dot.className = 'conn-dot';
  if (state === 'ok') {
    dot.classList.add('ok');
    label.textContent = `Connected \u00B7 ${PI_HOST}:${PI_PORT}`;
  } else if (state === 'err') {
    dot.classList.add('err');
    label.textContent = `Offline \u00B7 ${PI_HOST}:${PI_PORT}`;
  } else if (state === 'demo') {
    dot.classList.add('demo');
    label.textContent = 'Demo mode';
  }
}

// ==========================================
//  OCCUPANCY POLLING
// ==========================================
async function pollPi() {
  if (DEMO_MODE) {
    demoOccupancy += Math.round((Math.random() - 0.4) * 3);
    demoOccupancy = Math.max(0, Math.min(60, demoOccupancy));
    updateOccupancyUI(demoOccupancy);
    return;
  }
  try {
    const res  = await fetch(`http://${PI_HOST}:${PI_PORT}/api/count`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    updateOccupancyUI(data.occupancy ?? 0);
    setConnected('ok');
  } catch {
    setConnected('err');
  }
}

function updateOccupancyUI(count) {
  count = Math.max(0, count);

  // Occupancy value
  const occEl = document.getElementById('stat-occupancy');
  if (occEl) occEl.textContent = count;

  // Status badge
  const badge = document.getElementById('badge-occupancy');
  if (badge) {
    if (count === 0) {
      badge.className = 'stat-badge badge-muted'; badge.textContent = 'Empty';
    } else if (count < 10) {
      badge.className = 'stat-badge badge-green'; badge.textContent = 'Active';
    } else if (count < 30) {
      badge.className = 'stat-badge badge-amber'; badge.textContent = 'Busy';
    } else {
      badge.className = 'stat-badge badge-red';   badge.textContent = 'Crowded';
    }
  }

  // Peak
  if (count > peakCount) {
    peakCount = count;
    peakTime  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  const peakEl = document.getElementById('stat-peak');
  if (peakEl) peakEl.textContent = peakCount;
  const peakTimeEl = document.getElementById('stat-peak-time');
  if (peakTimeEl) peakTimeEl.textContent = `at ${peakTime}`;

  // Hourly average
  const hr = new Date().getHours();
  occupancyHistory[hr] = Math.max(occupancyHistory[hr], count);
  const filled = occupancyHistory.filter(v => v > 0);
  const avg = filled.length
    ? (filled.reduce((a, b) => a + b, 0) / filled.length).toFixed(1)
    : '0';
  const avgEl = document.getElementById('stat-avg');
  if (avgEl) avgEl.textContent = avg;

  renderChart(occupancyHistory);
}

// ==========================================
//  CAMERA FEED
// ==========================================
function startFeed() {
  if (DEMO_MODE) return;
  const img       = document.getElementById('camera-stream');
  const offline   = document.getElementById('feed-offline');
  const statusDot = document.getElementById('feed-status-dot');

  img.onload = () => {
    img.style.display = 'block';
    if (offline)   offline.style.display   = 'none';
    if (statusDot) statusDot.classList.add('live');
  };

  img.onerror = () => {
    img.style.display = 'none';
    if (offline)   offline.style.display   = 'flex';
    if (statusDot) statusDot.classList.remove('live');
  };

  img.src = `http://${PI_HOST}:${PI_PORT}/video_feed`;
}

// ==========================================
//  EVENTS LOG
// ==========================================
async function loadEvents() {
  if (DEMO_MODE) { renderEvents(MOCK_EVENTS); return; }
  try {
    const res    = await fetch(`http://${PI_HOST}:${PI_PORT}/api/events?limit=${EVENT_LIMIT}`, { signal: AbortSignal.timeout(2500) });
    const events = await res.json();
    renderEvents(events);
  } catch {
    /* silently ignore; keep previous events shown */
  }
}

function renderEvents(events) {
  const container = document.getElementById('events-body');
  const countEl   = document.getElementById('event-count');
  if (!container) return;

  if (!Array.isArray(events) || events.length === 0) {
    container.innerHTML = '<div class="events-empty">No events yet</div>';
    if (countEl) countEl.textContent = '0 events';
    return;
  }

  if (countEl) countEl.textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;

  container.innerHTML = events.map(e => {
    const time     = new Date(e.timestamp * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dirClass = e.direction === 'entry' ? 'dir-entry' : 'dir-exit';
    const dirLabel = e.direction === 'entry' ? 'ENTRY' : 'EXIT';
    return `
      <div class="event-row">
        <span class="event-dir ${dirClass}">${dirLabel}</span>
        <span class="event-occ">${e.occupancy} ppl</span>
        <span class="event-time">${time}</span>
      </div>`;
  }).join('');
}

// ==========================================
//  HOURLY BAR CHART
// ==========================================
function renderChart(data) {
  const container = document.getElementById('chart-bars');
  if (!container) return;

  const max     = Math.max(...data, 1);
  const curHr   = new Date().getHours();
  const peakIdx = data.indexOf(Math.max(...data));

  const labels = Array.from({ length: 24 }, (_, i) => {
    if (i === 0)  return '12a';
    if (i === 12) return '12p';
    return i < 12 ? `${i}a` : `${i - 12}p`;
  });

  container.innerHTML = data.map((v, i) => {
    const h   = Math.max((v / max) * 100, v > 0 ? 3 : 0);
    const cls = i === curHr ? 'now' : (i === peakIdx && v > 0 ? 'peak' : 'norm');
    const lbl = i % 3 === 0 ? labels[i] : '';
    return `
      <div class="bar-col">
        <div class="bar-tooltip">${labels[i]}: ${v}</div>
        <div class="bar ${cls}" style="height:${h}%"></div>
        <div class="bar-label" style="${lbl ? '' : 'visibility:hidden'}">${lbl || labels[i]}</div>
      </div>`;
  }).join('');
}

// ==========================================
//  INIT
// ==========================================
async function init() {
  peakCount        = 0;
  peakTime         = '--:--';
  occupancyHistory = new Array(24).fill(0);

  if (DEMO_MODE) {
    occupancyHistory = [...MOCK_HOURLY];
    peakCount = Math.max(...MOCK_HOURLY);
    const pi  = MOCK_HOURLY.indexOf(peakCount);
    peakTime  = pi < 12 ? `${pi || 12}:00 AM` : `${pi === 12 ? 12 : pi - 12}:00 PM`;
    renderChart(occupancyHistory);
    renderEvents(MOCK_EVENTS);
    updateOccupancyUI(demoOccupancy);
  } else {
    // Historical hourly data
    try {
      const res  = await fetch(`http://${PI_HOST}:${PI_PORT}/api/hourly`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      if (Array.isArray(data) && data.length === 24) occupancyHistory = data;
    } catch { console.warn('Could not load hourly history.'); }

    // Peak data
    try {
      const res  = await fetch(`http://${PI_HOST}:${PI_PORT}/api/peak`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      if (data.peak_count) peakCount = data.peak_count;
      if (data.peak_time)  peakTime  = data.peak_time;
    } catch { console.warn('Could not load peak data.'); }

    renderChart(occupancyHistory);
    loadEvents();
  }

  startFeed();
  pollPi();
  setInterval(pollPi,    POLL_MS);
  setInterval(loadEvents, DB_REFRESH);
}
