// CONFIG
const POLL_MS   = 3000;
const DB_REFRESH= 15000;

let PI_HOST   = 'localhost';
let PI_PORT   = '8080';
let DEMO_MODE = false;

function applyConfig(demo = false) {
  DEMO_MODE = demo;
  if (!demo) {
    PI_HOST = document.getElementById('pi-ip-input').value.trim() || 'localhost';
    PI_PORT = document.getElementById('pi-port-input').value.trim() || '8080';
  }
  document.getElementById('config-overlay').style.display = 'none';
  document.getElementById('pi-url-display').textContent   = `${PI_HOST}:${PI_PORT}`;
  init();
}

// CLOCK
function tickClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-GB', { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// MOCK DB DATA
const MOCK_HOURLY = [2,1,3,5,9,14,22,28,25,20,17,13,11,15,21,26,20,14,9,6,4,3,2,1];
const MOCK_DWELL  = { today: 42, week: 38, peak: 87 };

// STATE
let peakCount = 0;
let peakTime  = '--';
let occupancyHistory = new Array(24).fill(0);

// PI POLLING
async function pollPi() {
  if (DEMO_MODE) {
    updatePiUI({
      count:        Math.round(15 + Math.random() * 45), // Random occupancy
      cpu:          Math.round(30 + Math.random() * 30),
      ram_mb:       Math.round(170 + Math.random() * 70),
      sys_used_mb:  1100 + Math.round(Math.random() * 300),
      sys_total_mb: 3900
    });
    return;
  }
  try {
    const res  = await fetch(`http://${PI_HOST}:${PI_PORT}/api/count`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    
    updatePiUI({ count: data.occupancy }); 
  } catch (error) {
    console.error(error);
    setConnected(false);
  }
}

function updatePiUI(d) {
  const count = Math.max(0, d.count ?? 0);

  // 1. Current Occupancy (Card 1)
  const statOcc = document.getElementById('stat-occupancy');
  if (statOcc) statOcc.textContent = count;

  const overlayCount = document.getElementById('overlay-count');
  if (overlayCount) overlayCount.textContent  = count;

  const oTag = document.getElementById('tag-occupancy');
  if (oTag) {
      if (count === 0) {
          oTag.className = 'stat-tag tag-blue'; oTag.textContent = 'Empty';
      } else {
          oTag.className = 'stat-tag tag-green'; oTag.textContent = 'Active';
      }
  }

  // 2. Calculate Peak
  if (count > peakCount) {
    peakCount = count;
    peakTime  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  // 3. Calculate Hourly Average
  const hr = new Date().getHours();
  occupancyHistory[hr] = Math.max(occupancyHistory[hr], count);
  const filled = occupancyHistory.filter(v => v > 0);
  const avg = filled.length ? Math.round(filled.reduce((a,b) => a+b,0) / filled.length) : 0;
  
  if (typeof renderChart === 'function') {
      renderChart(occupancyHistory);
  }

  // 4. Update the NEW Daily Summary Box
  const comboPeak = document.getElementById('stat-combo-peak');
  if (comboPeak) comboPeak.textContent = peakCount;
  
  const comboTime = document.getElementById('stat-combo-time');
  if (comboTime) comboTime.textContent = `Peak at ${peakTime}`;
  
  const comboAvg = document.getElementById('stat-combo-avg');
  if (comboAvg) comboAvg.textContent = `Avg: ${avg} / hr`;

  // 5. Update old cards ONLY if they still exist
  const oldPeak = document.getElementById('stat-peak');
  if (oldPeak) oldPeak.textContent = peakCount;
  
  const oldTime = document.getElementById('stat-peak-time');
  if (oldTime) oldTime.textContent = `at ${peakTime}`;
  
  const oldAvg = document.getElementById('stat-avg');
  if (oldAvg) oldAvg.textContent = avg;

  setConnected(true);
}

function setConnected(ok) {
  const dot = document.getElementById('pi-conn-dot');
  const text = document.getElementById('pi-conn-text');
  
  if (dot) dot.className = `conn-dot ${ok ? 'ok' : 'err'}`;
  if (text) text.textContent = ok ? `Connected to ${PI_HOST}:${PI_PORT}` : `Offline (${PI_HOST}:${PI_PORT})`;

}

// CAMERA FEED
function startFeed() {
  if (DEMO_MODE) return;
  const img = document.getElementById('camera-stream');
  
  img.onload = handleFeedLoad;
  img.onerror = handleFeedError;
  
  img.src   = `http://${PI_HOST}:${PI_PORT}/video_feed`;
  img.style.display = 'block';
}

function handleFeedLoad() {
  const offlineMsg = document.getElementById('feed-offline');
  const overlay    = document.getElementById('feed-overlay');
  const stream     = document.getElementById('camera-stream');

  if (offlineMsg) offlineMsg.style.display = 'none';
  if (overlay)    overlay.style.display    = 'flex';
  if (stream)     stream.style.display     = 'block';
}

function handleFeedError() {
  const stream     = document.getElementById('camera-stream');
  const offlineMsg = document.getElementById('feed-offline');
  const overlay    = document.getElementById('feed-overlay');

  if (stream)     stream.style.display     = 'none';
  if (offlineMsg) offlineMsg.style.display = 'flex';
  if (overlay)    overlay.style.display    = 'none';
}

// CHART
function renderChart(data) {
  const container = document.getElementById('chart-bars');
  const max       = Math.max(...data, 1);
  const currentHr = new Date().getHours();
  const peakIdx   = data.indexOf(Math.max(...data));
  const labels    = Array.from({length:24}, (_,i) => {
    if (i === 0)  return '12a';
    if (i < 12)   return `${i}a`;
    if (i === 12) return '12p';
    return `${i-12}p`;
  });

  container.innerHTML = data.map((v, i) => {
    const h   = Math.max((v / max) * 100, v > 0 ? 2 : 0);
    const cls = i === currentHr ? 'now' : (i === peakIdx && v === Math.max(...data) ? 'peak' : 'norm');
    const lbl = i % 3 === 0
      ? `<div class="bar-label">${labels[i]}</div>`
      : `<div class="bar-label" style="visibility:hidden;">x</div>`;
    return `
      <div class="bar-col">
        <div class="bar-tooltip">${labels[i]}: ${v}</div>
        <div class="bar ${cls}" style="height:${h}%;"></div>
        ${lbl}
      </div>`;
  }).join('');
}

// DB DATA LOADER
function loadDB() {
  renderDwell(MOCK_DWELL);

  if (DEMO_MODE) {
    renderChart(MOCK_HOURLY);
    const peakVal = Math.max(...MOCK_HOURLY);
    const peakIdx = MOCK_HOURLY.indexOf(peakVal);
    peakCount = peakVal;
    peakTime  = `${peakIdx === 0 ? 12 : peakIdx > 12 ? peakIdx - 12 : peakIdx}:00 ${peakIdx >= 12 ? 'PM' : 'AM'}`;
    document.getElementById('stat-peak').textContent      = peakCount;
    document.getElementById('stat-peak-time').textContent = `at ${peakTime}`;
    const avg = Math.round(
      MOCK_HOURLY.filter(v=>v>0).reduce((a,b)=>a+b,0) /
      MOCK_HOURLY.filter(v=>v>0).length
    );
    document.getElementById('stat-avg').textContent = avg;
  }
}

function renderDwell(d) {
  // Grab the elements first
  const todayEl = document.getElementById('dwell-today');
  const weekEl  = document.getElementById('dwell-week');
  const peakEl  = document.getElementById('dwell-peak');

  if (todayEl) todayEl.textContent = `${d.today} min`;
  if (weekEl)  weekEl.textContent  = `${d.week} min`;
  if (peakEl)  peakEl.textContent  = `${d.peak} min`;
}

// INIT
function init() {
  loadDB();
  startFeed();
  pollPi();
  setInterval(pollPi, POLL_MS);
  setInterval(loadDB, DB_REFRESH);
}