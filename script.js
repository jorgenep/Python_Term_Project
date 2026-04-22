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
    const res  = await fetch(`http://${PI_HOST}:${PI_PORT}/data`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json();
    updatePiUI(data);
  } catch {
    setConnected(false);
  }
}

function updatePiUI(d) {
  const count = Math.max(0, d.count ?? 0);

  // Stats
  document.getElementById('stat-occupancy').textContent = count;
  document.getElementById('overlay-count').textContent  = count;

  const oTag = document.getElementById('tag-occupancy');
  if (count === 0) {
      oTag.className = 'stat-tag tag-blue'; oTag.textContent = 'Empty';
  } else {
      oTag.className = 'stat-tag tag-green'; oTag.textContent = 'Active';
  }

  // Peak tracking
  if (count > peakCount) {
    peakCount = count;
    peakTime  = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  document.getElementById('stat-peak').textContent      = peakCount;
  document.getElementById('stat-peak-time').textContent = `at ${peakTime}`;

  // Hourly history + daily average
  const hr = new Date().getHours();
  occupancyHistory[hr] = Math.max(occupancyHistory[hr], count);
  const filled = occupancyHistory.filter(v => v > 0);
  document.getElementById('stat-avg').textContent =
    filled.length ? Math.round(filled.reduce((a,b) => a+b,0) / filled.length) : 0;
  renderChart(occupancyHistory);

  // CPU
  const cpu = d.cpu ?? 0;
  document.getElementById('stat-cpu').textContent   = `${cpu}%`;
  document.getElementById('pi-cpu-val').textContent = `${cpu}%`;
  document.getElementById('cpu-bar').style.width    = `${Math.min(cpu,100)}%`;
  document.getElementById('cpu-bar').style.background =
    cpu > 80 ? 'var(--red)' : cpu > 50 ? 'var(--amber)' : 'var(--accent)';
  const cTag = document.getElementById('tag-cpu');
  cTag.className   = cpu > 80 ? 'stat-tag tag-red' : cpu > 50 ? 'stat-tag tag-amber' : 'stat-tag tag-green';
  cTag.textContent = cpu > 80 ? 'High load' : cpu > 50 ? 'Moderate' : 'Normal';

  // RAM
  const ram      = d.ram_mb       ?? 0;
  const sysUsed  = d.sys_used_mb  ?? 0;
  const sysTotal = d.sys_total_mb ?? 0;
  const ramPct   = sysTotal ? Math.round((sysUsed / sysTotal) * 100) : 0;
  document.getElementById('pi-ram-val').textContent    = `${ram} MB`;
  document.getElementById('pi-sysram-val').textContent = `${sysUsed}/${sysTotal} MB`;
  document.getElementById('ram-bar').style.width       = `${Math.min(ramPct,100)}%`;
  document.getElementById('ram-bar').style.background  =
    ramPct > 85 ? 'var(--red)' : ramPct > 60 ? 'var(--amber)' : 'var(--green)';

  setConnected(true);
}

function setConnected(ok) {
  document.getElementById('pi-conn-dot').className     = `conn-dot ${ok ? 'ok' : 'err'}`;
  document.getElementById('pi-conn-text').textContent  = ok
    ? `Connected to ${PI_HOST}:${PI_PORT}` : `Offline (${PI_HOST}:${PI_PORT})`;
  const tag = document.getElementById('feed-conn-tag');
  tag.className   = ok ? 'stat-tag tag-green' : 'stat-tag tag-red';
  tag.textContent = ok ? 'Stream active' : 'Offline';
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
  document.getElementById('feed-offline').style.display = 'none';
  document.getElementById('feed-overlay').style.display = 'flex';
}

function handleFeedError() {
  document.getElementById('camera-stream').style.display = 'none';
  document.getElementById('feed-offline').style.display  = 'flex';
  document.getElementById('feed-overlay').style.display  = 'none';
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
  document.getElementById('dwell-today').textContent = `${d.today} min`;
  document.getElementById('dwell-week').textContent  = `${d.week} min`;
  document.getElementById('dwell-peak').textContent  = `${d.peak} min`;
}

// INIT
function init() {
  loadDB();
  startFeed();
  pollPi();
  setInterval(pollPi, POLL_MS);
  setInterval(loadDB, DB_REFRESH);
}