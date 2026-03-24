const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const loginOverlay = document.getElementById('loginOverlay');
const deadOverlay = document.getElementById('deadOverlay');
const joinForm = document.getElementById('joinForm');
const nameInput = document.getElementById('nameInput');
const backButton = document.getElementById('backButton');
const healthBar = document.getElementById('healthBar');
const healthText = document.getElementById('healthText');
const announcement = document.getElementById('announcement');
const deadReason = document.getElementById('deadReason');
const hud = document.getElementById('hud');

const socket = io();

const state = {
  connected: false,
  joined: false,
  playing: false,
  pointerLocked: false,
  worldSize: 3200,
  id: null,
  name: '',
  camera: { x: 1600, y: 1600 },
  aimAngle: 0,
  input: { up: false, down: false, left: false, right: false, fire: false },
  snapshot: { players: [], bullets: [], worldSize: 3200 },
  me: null,
  lastSent: 0,
  msgTimer: 0,
  zoom: 0.24,
  targetZoom: 0.24,
  lobbyZoom: 0.24,
  playZoom: 1,
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
  state.msgTimer = setTimeout(() => announcement.classList.remove('visible'), 1800);
}

function syncUi() {
  loginOverlay.style.display = state.joined ? 'none' : 'flex';
  hud.style.display = state.playing ? 'block' : 'none';
  deadOverlay.style.display = deadOverlay.dataset.show === '1' ? 'grid' : 'none';
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
});

canvas.addEventListener('mousemove', (e) => {
  if (!state.playing || !state.pointerLocked) return;
  state.aimAngle += e.movementX * 0.0032;
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
});

backButton.addEventListener('click', () => {
  deadOverlay.dataset.show = '0';
  state.joined = false;
  state.playing = false;
  state.me = null;
  state.targetZoom = state.lobbyZoom;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  syncUi();
});

socket.on('connect', () => {
  state.connected = true;
});

socket.on('hello', ({ worldSize }) => {
  state.worldSize = worldSize || state.worldSize;
  state.camera.x = state.worldSize / 2;
  state.camera.y = state.worldSize / 2;
});

socket.on('joined', ({ id, name, worldSize, spawn }) => {
  state.id = id;
  state.name = name;
  state.worldSize = worldSize || state.worldSize;
  state.joined = true;
  state.playing = true;
  state.aimAngle = 0;
  state.camera.x = spawn?.x || state.camera.x;
  state.camera.y = spawn?.y || state.camera.y;
  state.targetZoom = state.playZoom;
  deadOverlay.dataset.show = '0';
  showAnnouncement(name);
  canvas.requestPointerLock?.();
  sendInput(true);
  syncUi();
});

socket.on('state', (snapshot) => {
  state.snapshot = snapshot;
  const me = snapshot.players.find((p) => p.id === state.id);
  state.me = me || null;
  if (me) {
    if (!state.pointerLocked) state.aimAngle = me.angle || 0;
    const ratio = Math.max(0, Math.min(1, me.health / me.maxHealth));
    healthBar.style.width = `${Math.round(ratio * 100)}%`;
    healthText.textContent = `${Math.max(0, Math.round(me.health))}`;
  }
});

socket.on('announcement', ({ text } = {}) => {
  if (text) showAnnouncement(text);
});

socket.on('dead', ({ reason } = {}) => {
  state.playing = false;
  state.joined = false;
  state.me = null;
  state.input = { up: false, down: false, left: false, right: false, fire: false };
  state.targetZoom = state.lobbyZoom;
  deadReason.textContent = reason || 'Rejoin to jump back in.';
  deadOverlay.dataset.show = '1';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  syncUi();
});

socket.on('disconnect', () => {
  state.connected = false;
  state.joined = false;
  state.playing = false;
  state.me = null;
  state.targetZoom = state.lobbyZoom;
  if (deadOverlay.dataset.show !== '1') deadOverlay.style.display = 'none';
  syncUi();
});

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function worldToScreen(x, y, camX, camY, zoom) {
  return {
    x: (x - camX) * zoom + window.innerWidth / 2,
    y: (y - camY) * zoom + window.innerHeight / 2,
  };
}

function drawWorld(camX, camY, zoom) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.fillStyle = '#f7f7f4';
  ctx.fillRect(0, 0, w, h);

  const grid = 120;
  const offsetX = -(((camX * zoom) - w / 2) % (grid * zoom));
  const offsetY = -(((camY * zoom) - h / 2) % (grid * zoom));
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  for (let x = offsetX; x < w; x += grid * zoom) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = offsetY; y < h; y += grid * zoom) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const topLeft = worldToScreen(0, 0, camX, camY, zoom);
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = Math.max(2, 4 * zoom);
  ctx.strokeRect(topLeft.x, topLeft.y, state.worldSize * zoom, state.worldSize * zoom);
}

function drawBullet(b, camX, camY, zoom) {
  const p = worldToScreen(b.x, b.y, camX, camY, zoom);
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(2, 4 * zoom), 0, Math.PI * 2);
  ctx.fill();
}

function drawMouse(p, x, y, size) {
  const body = size * 0.46;
  const ear = size * 0.18;
  const gunW = size * 0.42;
  const gunH = Math.max(4, size * 0.12);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(p.angle || 0);

  ctx.strokeStyle = '#111';
  ctx.lineWidth = Math.max(2, size * 0.07);
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(-body * 0.7, 0);
  ctx.quadraticCurveTo(-body * 1.7, -body * 0.55, -body * 1.2, -body * 0.05);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-body * 0.2, -body * 0.62, ear, 0, Math.PI * 2);
  ctx.arc(-body * 0.2, body * 0.62, ear, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(0, 0, body, body * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.arc(body * 0.35, 0, Math.max(1.5, size * 0.05), 0, Math.PI * 2);
  ctx.fill();

  ctx.fillRect(body * 0.18, -gunH / 2, gunW, gunH);
  ctx.fillRect(body * 0.18 + gunW - gunH * 0.3, -gunH * 0.9, gunH * 0.6, gunH * 1.8);

  ctx.restore();
}

function drawPlayer(p, camX, camY, zoom) {
  const pos = worldToScreen(p.x, p.y, camX, camY, zoom);
  const me = p.id === state.id;
  const size = Math.max(14, (me ? 44 : 36) * zoom);

  drawMouse(p, pos.x, pos.y, size);

  if (zoom > 0.42 || me) {
    ctx.fillStyle = '#111';
    ctx.font = `${Math.max(10, 12 * zoom + (me ? 2 : 0))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(p.name, pos.x, pos.y - size * 0.95);
  }

  if (zoom > 0.3 || me) {
    const w = Math.max(18, 34 * zoom);
    const h = Math.max(3, 5 * zoom);
    const ratio = Math.max(0, Math.min(1, p.health / p.maxHealth));
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(pos.x - w / 2, pos.y + size * 0.78, w, h);
    ctx.fillStyle = '#111';
    ctx.fillRect(pos.x - w / 2, pos.y + size * 0.78, w * ratio, h);
  }
}

function drawCrosshair() {
  const x = window.innerWidth / 2;
  const y = window.innerHeight / 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
  ctx.stroke();
}

function drawLobbyLabel() {
  if (state.joined) return;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(16, 16, 210, 56);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.strokeRect(16, 16, 210, 56);
  ctx.fillStyle = '#111';
  ctx.font = '600 15px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('MouseThing', 30, 38);
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.fillText('Pick a name while watching the map', 30, 57);
}

function render() {
  requestAnimationFrame(render);

  state.zoom = lerp(state.zoom, state.targetZoom, 0.08);

  if (state.me && state.playing) {
    state.camera.x = lerp(state.camera.x, state.me.x, 0.12);
    state.camera.y = lerp(state.camera.y, state.me.y, 0.12);
  } else {
    state.camera.x = lerp(state.camera.x, state.worldSize / 2, 0.04);
    state.camera.y = lerp(state.camera.y, state.worldSize / 2, 0.04);
  }

  const camX = state.camera.x;
  const camY = state.camera.y;
  const zoom = state.zoom;

  drawWorld(camX, camY, zoom);
  for (const b of state.snapshot.bullets || []) drawBullet(b, camX, camY, zoom);
  for (const p of state.snapshot.players || []) drawPlayer(p, camX, camY, zoom);
  if (state.playing) drawCrosshair();
  if (!state.joined) drawLobbyLabel();
  if (state.joined) sendInput();
}

syncUi();
render();
