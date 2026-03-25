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

const mouseSprite = new Image();
mouseSprite.src = '/mouse.png';

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
  renderPlayers: new Map(),
  renderBullets: new Map(),
  shockwaves: [],
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
  canvas.style.cursor = state.playing && state.pointerLocked ? 'none' : 'default';
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
  state.shockwaves.push({
    x: state.camera.x,
    y: state.camera.y,
    radius: 18,
    maxRadius: 160,
    ttl: 0.45,
    life: 0,
  });
  showAnnouncement(name);
  syncUi();
  sendInput(true);
});

socket.on('state', (snapshot) => {
  state.snapshot = snapshot;

  const me = snapshot.players.find((p) => p.id === state.id);
  state.me = me || null;

  const seenPlayers = new Set();
  for (const p of snapshot.players) {
    seenPlayers.add(p.id);
    const existing = state.renderPlayers.get(p.id);
    if (!existing) {
      state.renderPlayers.set(p.id, {
        id: p.id,
        x: p.x,
        y: p.y,
        angle: p.angle || 0,
        targetX: p.x,
        targetY: p.y,
        targetAngle: p.angle || 0,
        health: p.health,
        maxHealth: p.maxHealth,
        name: p.name,
        color: p.color,
      });
    } else {
      existing.targetX = p.x;
      existing.targetY = p.y;
      existing.targetAngle = p.angle || 0;
      existing.health = p.health;
      existing.maxHealth = p.maxHealth;
      existing.name = p.name;
      existing.color = p.color;
    }
  }
  for (const id of [...state.renderPlayers.keys()]) {
    if (!seenPlayers.has(id)) state.renderPlayers.delete(id);
  }

  const seenBullets = new Set();
  for (const b of snapshot.bullets) {
    seenBullets.add(b.id);
    const existing = state.renderBullets.get(b.id);
    if (!existing) {
      state.renderBullets.set(b.id, {
        id: b.id,
        x: b.x,
        y: b.y,
        angle: b.angle || 0,
        targetX: b.x,
        targetY: b.y,
      });
    } else {
      existing.targetX = b.x;
      existing.targetY = b.y;
      existing.angle = b.angle || 0;
    }
  }
  for (const id of [...state.renderBullets.keys()]) {
    if (!seenBullets.has(id)) state.renderBullets.delete(id);
  }

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

function angleLerp(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
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

function drawShockwaves(dt, camX, camY, zoom) {
  for (let i = state.shockwaves.length - 1; i >= 0; i--) {
    const s = state.shockwaves[i];
    s.life += dt;
    const t = s.life / s.ttl;
    if (t >= 1) {
      state.shockwaves.splice(i, 1);
      continue;
    }
    const radius = lerp(s.radius, s.maxRadius, t);
    const p = worldToScreen(s.x, s.y, camX, camY, zoom);
    ctx.strokeStyle = `rgba(0,0,0,${(1 - t) * 0.22})`;
    ctx.lineWidth = Math.max(1, 5 * zoom * (1 - t * 0.4));
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawPlayer(p, camX, camY, zoom) {
  const pos = worldToScreen(p.x, p.y, camX, camY, zoom);
  const me = p.id === state.id;
  const size = Math.max(16, (me ? 56 : 46) * zoom);

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate((p.angle || 0) + Math.PI / 3);

  if (mouseSprite.complete) {
    ctx.drawImage(mouseSprite, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(-size / 2, -size / 3, size, size * 0.66);
  }

  ctx.restore();

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
    ctx.fillRect(pos.x - w / 2, pos.y + size * 0.72, w, h);
    ctx.fillStyle = '#111';
    ctx.fillRect(pos.x - w / 2, pos.y + size * 0.72, w * ratio, h);
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

let lastFrame = performance.now();

function render() {
  requestAnimationFrame(render);

  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  state.zoom = lerp(state.zoom, state.targetZoom, 0.08);

  for (const p of state.renderPlayers.values()) {
    p.x = lerp(p.x, p.targetX, 0.22);
    p.y = lerp(p.y, p.targetY, 0.22);
    p.angle = angleLerp(p.angle || 0, p.targetAngle || 0, 0.22);
  }

  for (const b of state.renderBullets.values()) {
    b.x = lerp(b.x, b.targetX, 0.35);
    b.y = lerp(b.y, b.targetY, 0.35);
  }

  const renderedMe = state.renderPlayers.get(state.id);
  if (renderedMe && state.playing) {
    state.camera.x = lerp(state.camera.x, renderedMe.x, 0.12);
    state.camera.y = lerp(state.camera.y, renderedMe.y, 0.12);
  } else {
    state.camera.x = lerp(state.camera.x, state.worldSize / 2, 0.04);
    state.camera.y = lerp(state.camera.y, state.worldSize / 2, 0.04);
  }

  const camX = state.camera.x;
  const camY = state.camera.y;
  const zoom = state.zoom;

  drawWorld(camX, camY, zoom);

  for (const b of state.renderBullets.values()) drawBullet(b, camX, camY, zoom);
  for (const p of state.renderPlayers.values()) drawPlayer(p, camX, camY, zoom);

  drawShockwaves(dt, camX, camY, zoom);

  if (state.playing) drawCrosshair();
  if (!state.joined) drawLobbyLabel();
  if (state.joined) sendInput();
}

syncUi();
render();
