const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const loginOverlay = document.getElementById('loginOverlay');
const deadOverlay = document.getElementById('deadOverlay');
const joinForm = document.getElementById('joinForm');
const nameInput = document.getElementById('nameInput');
const backButton = document.getElementById('backButton');
const healthBar = document.getElementById('healthBar');
const healthText = document.getElementById('healthText');
const statusText = document.getElementById('statusText');
const nameTag = document.getElementById('nameTag');
const announcement = document.getElementById('announcement');
const deadReason = document.getElementById('deadReason');
const hud = document.getElementById('hud');

const socket = io();

const mouseSprite = new Image();
mouseSprite.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M44 16c-8 0-14 6-14 14v40c0 27 15 42 34 42 22 0 34-13 34-38V46c0-16-12-30-28-30z" stroke="#0f172a" stroke-width="14" fill="#f8fafc"/>
    <path d="M54 22c-7 0-12 5-12 12" stroke="#0f172a" stroke-width="10"/>
    <path d="M78 22c7 0 12 5 12 12" stroke="#0f172a" stroke-width="10"/>
    <rect x="70" y="56" width="34" height="11" rx="5.5" fill="#0f172a" transform="rotate(25 70 56)"/>
    <path d="M88 72l18 4" stroke="#0f172a" stroke-width="7"/>
  </g>
</svg>`);

const state = {
  connected: false,
  joined: false,
  playing: false,
  pointerLocked: false,
  worldSize: 3200,
  id: null,
  name: '',
  camera: { x: 0, y: 0 },
  aimAngle: 0,
  input: { up: false, down: false, left: false, right: false, fire: false },
  snapshot: { players: [], bullets: [], worldSize: 3200 },
  me: null,
  lastSent: 0,
  msgTimer: 0,
};

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function showAnnouncement(text) {
  announcement.textContent = text;
  announcement.classList.add('visible');
  clearTimeout(state.msgTimer);
  state.msgTimer = setTimeout(() => announcement.classList.remove('visible'), 2200);
}

function syncUi() {
  loginOverlay.style.display = state.joined ? 'none' : 'block';
  hud.style.display = state.playing ? 'block' : 'none';
  if (deadOverlay.dataset.show === '1') deadOverlay.style.display = 'grid';
  statusText.textContent = state.connected ? (state.playing ? 'In game' : 'Ready') : 'Connecting…';
  nameTag.textContent = state.name ? `@${state.name}` : '@Mouse';
}

function sendInput(force = false) {
  if (!state.joined) return;
  const now = performance.now();
  if (!force && now - state.lastSent < 33) return;
  state.lastSent = now;
  socket.emit('input', { ...state.input, angle: state.aimAngle });
}

function keyToAction(key, down) {
  if (key === 'w' || key === 'arrowup') state.input.up = down;
  if (key === 's' || key === 'arrowdown') state.input.down = down;
  if (key === 'a' || key === 'arrowleft') state.input.left = down;
  if (key === 'd' || key === 'arrowright') state.input.right = down;
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keyToAction(e.key.toLowerCase(), true);
  if (e.key === ' ' && state.playing) {
    e.preventDefault();
    state.input.fire = true;
  }
  sendInput(true);
});
window.addEventListener('keyup', (e) => {
  keyToAction(e.key.toLowerCase(), false);
  if (e.key === ' ') state.input.fire = false;
  sendInput(true);
});

document.addEventListener('pointerlockchange', () => {
  state.pointerLocked = document.pointerLockElement === canvas;
  syncUi();
});

canvas.addEventListener('mousemove', (e) => {
  if (!state.playing || !state.pointerLocked) return;
  state.aimAngle += e.movementX * 0.0035;
  sendInput();
});
canvas.addEventListener('mousedown', (e) => {
  if (!state.playing) return;
  if (!state.pointerLocked) {
    canvas.requestPointerLock();
    return;
  }
  if (e.button === 0) {
    state.input.fire = true;
    sendInput(true);
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) {
    state.input.fire = false;
    sendInput(true);
  }
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('join', { name: nameInput.value });
  syncUi();
});

backButton.addEventListener('click', () => {
  deadOverlay.dataset.show = '0';
  deadOverlay.style.display = 'none';
  loginOverlay.style.display = 'block';
  state.joined = false;
  state.playing = false;
  syncUi();
});

socket.on('connect', () => {
  state.connected = true;
  syncUi();
});

socket.on('hello', ({ worldSize }) => {
  state.worldSize = worldSize || state.worldSize;
});

socket.on('joined', ({ id, name, worldSize }) => {
  state.id = id;
  state.name = name;
  state.worldSize = worldSize || state.worldSize;
  state.joined = true;
  state.playing = true;
  state.aimAngle = 0;
  deadOverlay.dataset.show = '0';
  deadOverlay.style.display = 'none';
  loginOverlay.style.display = 'none';
  hud.style.display = 'block';
  showAnnouncement(`Welcome, ${name}`);
  canvas.requestPointerLock?.();
  sendInput(true);
  syncUi();
});

socket.on('state', (snapshot) => {
  state.snapshot = snapshot;
  const me = snapshot.players.find((p) => p.id === state.id);
  state.me = me || null;
  if (me) {
    state.camera.x = me.x;
    state.camera.y = me.y;
    if (!state.pointerLocked) state.aimAngle = me.angle || 0;
    const ratio = Math.max(0, Math.min(1, me.health / me.maxHealth));
    healthBar.style.width = `${Math.round(ratio * 100)}%`;
    healthText.textContent = `${Math.max(0, Math.round(me.health))} / ${me.maxHealth}`;
  }
});

socket.on('announcement', ({ text } = {}) => {
  if (text) showAnnouncement(text);
});

socket.on('dead', ({ reason } = {}) => {
  state.playing = false;
  state.joined = false;
  state.input = { up: false, down: false, left: false, right: false, fire: false };
  deadReason.textContent = reason || 'Rejoin to jump back in.';
  deadOverlay.dataset.show = '1';
  deadOverlay.style.display = 'grid';
  loginOverlay.style.display = 'none';
  hud.style.display = 'none';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  syncUi();
});

socket.on('disconnect', () => {
  state.connected = false;
  state.joined = false;
  state.playing = false;
  hud.style.display = 'none';
  if (deadOverlay.dataset.show !== '1') {
    loginOverlay.style.display = 'block';
    deadOverlay.style.display = 'none';
  }
  syncUi();
});

function drawWorld(camX, camY) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.fillStyle = '#eef7ff';
  ctx.fillRect(0, 0, w, h);

  const grid = 80;
  const gx = -((camX - w / 2) % grid);
  const gy = -((camY - h / 2) % grid);
  ctx.strokeStyle = 'rgba(93, 137, 176, 0.16)';
  ctx.lineWidth = 1;
  for (let x = gx; x < w; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = gy; y < h; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const worldX = w / 2 - camX;
  const worldY = h / 2 - camY;
  ctx.strokeStyle = 'rgba(61, 105, 144, 0.42)';
  ctx.lineWidth = 6;
  ctx.strokeRect(worldX + 34, worldY + 34, state.worldSize - 68, state.worldSize - 68);
}

function drawBullet(b, camX, camY) {
  const x = b.x - camX + window.innerWidth / 2;
  const y = b.y - camY + window.innerHeight / 2;
  ctx.fillStyle = '#244d8f';
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayer(p, camX, camY) {
  const x = p.x - camX + window.innerWidth / 2;
  const y = p.y - camY + window.innerHeight / 2;
  const me = p.id === state.id;
  const size = me ? 58 : 50;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(p.angle || 0);
  ctx.drawImage(mouseSprite, -size / 2, -size / 2, size, size);
  ctx.restore();

  ctx.strokeStyle = me ? '#1d7af3' : p.color;
  ctx.lineWidth = me ? 4 : 3;
  ctx.beginPath();
  ctx.arc(x, y, size * 0.62, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#214064';
  ctx.font = '600 14px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, x, y - size * 0.8);

  const barW = 54, barH = 7;
  const ratio = Math.max(0, Math.min(1, p.health / p.maxHealth));
  ctx.fillStyle = 'rgba(30,55,90,0.14)';
  ctx.fillRect(x - barW / 2, y - size * 0.8 + 8, barW, barH);
  ctx.fillStyle = ratio > 0.5 ? '#31b56f' : (ratio > 0.2 ? '#f0b12d' : '#ef5a5a');
  ctx.fillRect(x - barW / 2, y - size * 0.8 + 8, barW * ratio, barH);

  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(x + Math.cos(p.angle || 0) * 18 - 2, y + Math.sin(p.angle || 0) * 18 - 2, 24, 4);
}

function drawCrosshair() {
  const x = window.innerWidth / 2;
  const y = window.innerHeight / 2;
  ctx.strokeStyle = 'rgba(29,122,243,.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 18, y); ctx.lineTo(x - 8, y);
  ctx.moveTo(x + 8, y); ctx.lineTo(x + 18, y);
  ctx.moveTo(x, y - 18); ctx.lineTo(x, y - 8);
  ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 18);
  ctx.stroke();
}

function render() {
  requestAnimationFrame(render);
  const me = state.me;
  const camX = me ? me.x : state.camera.x;
  const camY = me ? me.y : state.camera.y;

  drawWorld(camX, camY);
  for (const b of state.snapshot.bullets || []) drawBullet(b, camX, camY);
  for (const p of state.snapshot.players || []) drawPlayer(p, camX, camY);
  if (state.playing) drawCrosshair();
  if (state.joined) sendInput();
}

syncUi();
render();
