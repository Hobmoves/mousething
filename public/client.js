/*
 * client.js
 *
 * Control model (the part that used to feel awful):
 *  - Movement is WORLD-absolute. W is up, always. It is not relative to where
 *    you are facing, so you never have to think about your own orientation.
 *  - Aim is ABSOLUTE: you point at the cursor. No pointer lock, no relative
 *    mouse accumulation, no sensitivity to get wrong.
 *  - Your own movement is simulated locally the instant you press a key
 *    (client-side prediction) and reconciled against the server, so input
 *    response is one frame instead of one network round trip.
 */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const el = (id) => document.getElementById(id);

const loginPanel = el('login');
const joinForm = el('joinForm');
const nameInput = el('nameInput');
const hud = el('hud');
const healthFill = el('healthFill');
const healthNum = el('healthNum');
const weaponName = el('weaponName');
const ammoText = el('ammoText');
const reloadWrap = el('reloadWrap');
const reloadFill = el('reloadFill');
const dashFill = el('dashFill');
const killfeed = el('killfeed');
const scoreboard = el('scoreboard');
const scoreBody = el('scoreBody');
const centerMsg = el('centerMsg');
const hurtVignette = el('hurt');
const soundBtn = el('soundBtn');

const socket = io();
const MT = window.MT;
const { CFG, WEAPONS } = MT;

const sprite = new Image();
sprite.src = '/mouse.png';

const S = {
  joined: false,
  id: null,
  world: CFG.WORLD,
  zoom: 0.9,
  // Predicted local player. This is what you actually steer.
  self: { x: CFG.WORLD / 2, y: CFG.WORLD / 2, vx: 0, vy: 0, aim: 0, dashTime: 0, dashCooldown: 0 },
  alive: true,
  health: CFG.MAX_HEALTH,
  hud: { mag: 0, magSize: 0, reserve: -1, reloading: 0, reloadTime: 1, respawnIn: 0 },
  weapon: 'pistol',
  pending: [],
  seq: 1,
  correction: { x: 0, y: 0 },
  snaps: [],
  players: [],
  pickups: [],
  bullets: [],
  camera: { x: CFG.WORLD / 2, y: CFG.WORLD / 2 },
  shake: 0,
  hurtFlash: 0,
  hitMarker: 0,
  particles: [],
  tracers: [],
  damageNumbers: [],
  keys: new Set(),
  mouse: { x: innerWidth / 2, y: innerHeight / 2, down: false },
  touch: { move: null, aim: null },
  usingTouch: false,
  wantDash: false,
  wantReload: false,
  showScores: false,
  sound: localStorage.getItem('mt-sound') !== 'off',
  lastEventIndex: 0,
};

/* ------------------------------- audio ------------------------------- */
let audio = null;
function ac() {
  if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
function blip({ freq = 440, type = 'square', dur = 0.08, vol = 0.15, sweep = 0 }) {
  if (!S.sound) return;
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur);
}
function noise({ dur = 0.1, vol = 0.14, hp = 700 }) {
  if (!S.sound) return;
  const a = ac();
  if (!a) return;
  const n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}
const SFX = {
  shot(weapon, dist) {
    const vol = Math.max(0.02, 0.16 * (1 - dist / 1400));
    if (vol <= 0.02) return;
    if (weapon === 'shotgun') { noise({ dur: 0.18, vol: vol * 1.3, hp: 350 }); blip({ freq: 120, dur: 0.12, vol, sweep: -70 }); }
    else if (weapon === 'railgun') { blip({ freq: 900, type: 'sawtooth', dur: 0.22, vol, sweep: -800 }); }
    else if (weapon === 'smg') { noise({ dur: 0.05, vol, hp: 1200 }); }
    else { noise({ dur: 0.07, vol, hp: 900 }); blip({ freq: 320, dur: 0.05, vol: vol * 0.7, sweep: -180 }); }
  },
  hit() { blip({ freq: 1200, type: 'square', dur: 0.04, vol: 0.09, sweep: -500 }); },
  hurt() { blip({ freq: 180, type: 'sawtooth', dur: 0.16, vol: 0.14, sweep: -120 }); },
  death() { noise({ dur: 0.3, vol: 0.18, hp: 200 }); blip({ freq: 260, dur: 0.35, vol: 0.12, sweep: -220 }); },
  pickup() { blip({ freq: 660, dur: 0.07, vol: 0.1 }); setTimeout(() => blip({ freq: 990, dur: 0.09, vol: 0.1 }), 70); },
  dash() { noise({ dur: 0.14, vol: 0.09, hp: 500 }); },
  reload() { blip({ freq: 240, dur: 0.05, vol: 0.08 }); setTimeout(() => blip({ freq: 180, dur: 0.06, vol: 0.08 }), 110); },
};

/* ------------------------------ canvas ------------------------------ */
// How much of the world you can see should not depend on your screen size.
function baseZoom() {
  return MT.clamp(Math.min(innerWidth, innerHeight) / 900, 0.42, 1.05);
}

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function worldToScreen(x, y) {
  return {
    x: (x - S.camera.x) * S.zoom + innerWidth / 2,
    y: (y - S.camera.y) * S.zoom + innerHeight / 2,
  };
}
function screenToWorld(x, y) {
  return {
    x: (x - innerWidth / 2) / S.zoom + S.camera.x,
    y: (y - innerHeight / 2) / S.zoom + S.camera.y,
  };
}

/* ------------------------------- input ------------------------------- */
const MOVE_KEYS = {
  w: [0, -1], arrowup: [0, -1],
  s: [0, 1], arrowdown: [0, 1],
  a: [-1, 0], arrowleft: [-1, 0],
  d: [1, 0], arrowright: [1, 0],
};

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'tab') { e.preventDefault(); S.showScores = true; scoreboard.classList.add('show'); return; }
  if (e.repeat) return;
  S.keys.add(k);
  if (k === ' ' || k === 'shift') { e.preventDefault(); S.wantDash = true; }
  if (k === 'r') S.wantReload = true;
  if (k === 'm') toggleSound();
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  S.keys.delete(k);
  if (k === 'tab') { S.showScores = false; scoreboard.classList.remove('show'); }
});
addEventListener('blur', () => { S.keys.clear(); S.mouse.down = false; });

canvas.addEventListener('mousemove', (e) => {
  S.mouse.x = e.clientX;
  S.mouse.y = e.clientY;
  S.usingTouch = false;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) S.mouse.down = true;
  if (e.button === 2) S.wantDash = true;
  ac();
});
addEventListener('mouseup', (e) => { if (e.button === 0) S.mouse.down = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* Touch: left half of the screen is a move stick, right half aims and fires. */
function touchPos(t) { return { x: t.clientX, y: t.clientY }; }
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  S.usingTouch = true;
  for (const t of e.changedTouches) {
    const p = touchPos(t);
    if (p.x < innerWidth / 2 && !S.touch.move) S.touch.move = { id: t.identifier, ox: p.x, oy: p.y, x: p.x, y: p.y };
    else if (!S.touch.aim) S.touch.aim = { id: t.identifier, ox: p.x, oy: p.y, x: p.x, y: p.y };
  }
  ac();
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    for (const key of ['move', 'aim']) {
      const s = S.touch[key];
      if (s && s.id === t.identifier) { const p = touchPos(t); s.x = p.x; s.y = p.y; }
    }
  }
}, { passive: false });
function endTouch(e) {
  for (const t of e.changedTouches) {
    if (S.touch.move && S.touch.move.id === t.identifier) S.touch.move = null;
    if (S.touch.aim && S.touch.aim.id === t.identifier) S.touch.aim = null;
  }
}
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

function toggleSound() {
  S.sound = !S.sound;
  localStorage.setItem('mt-sound', S.sound ? 'on' : 'off');
  soundBtn.textContent = S.sound ? 'sound on (M)' : 'sound off (M)';
}
soundBtn.addEventListener('click', toggleSound);
soundBtn.textContent = S.sound ? 'sound on (M)' : 'sound off (M)';

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  localStorage.setItem('mt-name', name);
  ac();
  socket.emit('join', { name });
});
nameInput.value = localStorage.getItem('mt-name') || '';

function readInput() {
  let mx = 0;
  let my = 0;
  for (const k of S.keys) {
    const v = MOVE_KEYS[k];
    if (v) { mx += v[0]; my += v[1]; }
  }
  if (S.touch.move) {
    const dx = S.touch.move.x - S.touch.move.ox;
    const dy = S.touch.move.y - S.touch.move.oy;
    const d = Math.hypot(dx, dy);
    if (d > 8) { const s = Math.min(1, d / 60) / d; mx = dx * s; my = dy * s; }
  }
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }

  let aim = S.self.aim;
  let fire = S.mouse.down;
  if (S.touch.aim) {
    const dx = S.touch.aim.x - S.touch.aim.ox;
    const dy = S.touch.aim.y - S.touch.aim.oy;
    if (Math.hypot(dx, dy) > 12) { aim = Math.atan2(dy, dx); fire = true; }
  } else {
    // Absolute aim: point at the cursor, in world space.
    const w = screenToWorld(S.mouse.x, S.mouse.y);
    aim = Math.atan2(w.y - S.self.y, w.x - S.self.x);
  }
  return { mx, my, aim, fire };
}

/* -------------------------- prediction loop -------------------------- */
function stepLocal(dt) {
  const inp = readInput();
  const cmd = {
    seq: S.seq++,
    dt,
    mx: inp.mx,
    my: inp.my,
    aim: inp.aim,
    fire: inp.fire && S.alive,
    dash: S.wantDash && S.alive,
    reload: S.wantReload,
  };
  S.wantDash = false;
  S.wantReload = false;

  if (S.alive) {
    const before = S.self.dashCooldown;
    MT.stepMovement(S.self, cmd, dt);
    if (S.self.dashCooldown > before) { SFX.dash(); S.shake = Math.max(S.shake, 2); }
    S.pending.push(cmd);
    if (S.pending.length > 180) S.pending.shift();
  } else {
    S.self.aim = inp.aim;
  }
  socket.emit('cmd', cmd);
}

function reconcile(server, ack) {
  const prevX = S.self.x;
  const prevY = S.self.y;

  S.self.x = server.x;
  S.self.y = server.y;
  S.self.vx = server.vx;
  S.self.vy = server.vy;
  S.self.dashTime = server.dashTime;
  S.self.dashCooldown = server.dashCooldown;

  S.pending = S.pending.filter((c) => c.seq > ack);
  for (const c of S.pending) MT.stepMovement(S.self, c, c.dt);

  // Rather than snapping to the corrected position (which reads as a stutter),
  // keep the visual error and bleed it off over a few frames.
  const ex = prevX - S.self.x;
  const ey = prevY - S.self.y;
  if (Math.hypot(ex, ey) < 220) {
    S.correction.x += ex;
    S.correction.y += ey;
  } else {
    S.correction.x = 0;
    S.correction.y = 0;
  }
}

/* ------------------------------ network ------------------------------ */
socket.on('hello', ({ world }) => { S.world = world || S.world; });

socket.on('joined', ({ id }) => {
  S.id = id;
  S.joined = true;
  S.alive = true;
  S.pending = [];
  loginPanel.classList.add('hidden');
  hud.classList.add('show');
});

socket.on('state', (snap) => {
  S.snaps.push(snap);
  while (S.snaps.length > 30) S.snaps.shift();

  if (snap.self) {
    const wasAlive = S.alive;
    reconcile(snap.self, snap.ack);
    S.hud = snap.self;
    S.alive = snap.self.respawnIn <= 0;
    if (wasAlive && !S.alive) SFX.death();
    if (!wasAlive && S.alive) { S.pending = []; S.correction.x = 0; S.correction.y = 0; }
  }

  const me = snap.players.find((p) => p.id === S.id);
  if (me) {
    if (me.health < S.health - 0.5) {
      S.hurtFlash = 1;
      S.shake = Math.max(S.shake, 5);
      SFX.hurt();
    }
    S.health = me.health;
    S.weapon = me.weapon;
  }

  for (const ev of snap.events || []) handleEvent(ev);
});

socket.on('feed', (f) => {
  if (f.join) return pushFeed(`<b>${esc(f.join)}</b> joined`);
  if (f.leave) return pushFeed(`<b>${esc(f.leave)}</b> left`);
  const w = f.weapon ? WEAPONS[f.weapon].name : '';
  pushFeed(`<b>${esc(f.killer || 'the void')}</b> <i>${esc(w)}</i> <b>${esc(f.victim)}</b>`
    + (f.streak >= 3 ? ` <span class="streak">x${f.streak}</span>` : ''));
});

socket.on('disconnect', () => {
  S.joined = false;
  hud.classList.remove('show');
  loginPanel.classList.remove('hidden');
});

function handleEvent(ev) {
  const dist = Math.hypot(ev.x - S.self.x, ev.y - S.self.y);
  switch (ev.t) {
    case 'shot':
      SFX.shot(ev.w, dist);
      muzzle(ev.x, ev.y, ev.a, ev.w);
      break;
    case 'hit':
      burst(ev.x, ev.y, ev.a, 9, ev.color || '#c2410c');
      if (ev.by === S.id) { S.hitMarker = 1; SFX.hit(); }
      S.damageNumbers.push({ x: ev.x, y: ev.y, v: Math.round(ev.dmg), life: 0, mine: ev.by === S.id });
      break;
    case 'spark':
      burst(ev.x, ev.y, ev.a + Math.PI, 5, '#8a8a8a');
      break;
    case 'death':
      burst(ev.x, ev.y, Math.random() * 7, 28, ev.color || '#111');
      if (dist < 900) S.shake = Math.max(S.shake, 7 * (1 - dist / 900));
      break;
    case 'pickup':
      if (ev.who === S.id) SFX.pickup();
      burst(ev.x, ev.y, 0, 10, ev.kind === 'health' ? '#047857' : '#1d4ed8');
      break;
    case 'reload':
      if (dist < 500) SFX.reload();
      break;
    default: break;
  }
}

/* ------------------------------ effects ------------------------------ */
function burst(x, y, angle, count, color) {
  for (let i = 0; i < count; i++) {
    const a = angle + (Math.random() - 0.5) * 1.9;
    const sp = 60 + Math.random() * 260;
    S.particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0, ttl: 0.25 + Math.random() * 0.4, color, size: 1.5 + Math.random() * 2.5,
    });
  }
  if (S.particles.length > 500) S.particles.splice(0, S.particles.length - 500);
}
function muzzle(x, y, a, w) {
  const spec = WEAPONS[w] || WEAPONS.pistol;
  S.tracers.push({ x, y, a, life: 0, ttl: 0.07, len: 30 + spec.kick * 6 });
  burst(x + Math.cos(a) * 26, y + Math.sin(a) * 26, a, 4, '#d97706');
  if (Math.hypot(x - S.self.x, y - S.self.y) < 60) S.shake = Math.max(S.shake, spec.shake);
}

function pushFeed(html) {
  const div = document.createElement('div');
  div.className = 'feed-item';
  div.innerHTML = html;
  killfeed.prepend(div);
  while (killfeed.children.length > 5) killfeed.lastChild.remove();
  setTimeout(() => div.classList.add('fade'), 4000);
  setTimeout(() => div.remove(), 5000);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------- interpolation --------------------------- */
function interpolated() {
  const renderTime = Date.now() - CFG.INTERP_DELAY * 1000;
  let a = null;
  let b = null;
  for (let i = S.snaps.length - 1; i >= 0; i--) {
    if (S.snaps[i].time <= renderTime) { a = S.snaps[i]; b = S.snaps[i + 1] || null; break; }
  }
  if (!a) a = S.snaps[0];
  if (!a) return { players: [], bullets: [], pickups: [] };

  const t = b && b.time > a.time ? MT.clamp((renderTime - a.time) / (b.time - a.time), 0, 1) : 0;
  const map = new Map((b ? b.players : []).map((p) => [p.id, p]));

  const players = a.players.map((p) => {
    const n = map.get(p.id);
    if (!n) return p;
    return {
      ...p,
      x: p.x + (n.x - p.x) * t,
      y: p.y + (n.y - p.y) * t,
      aim: p.aim + MT.shortestAngle(p.aim, n.aim) * t,
      health: p.health + (n.health - p.health) * t,
    };
  });

  // Bullets are dead-reckoned from their snapshot instead of interpolated --
  // they move too fast for interpolation to look right.
  const age = (Date.now() - a.time) / 1000;
  const bullets = a.bullets.map((bl) => ({ ...bl, x: bl.x + bl.dx * age, y: bl.y + bl.dy * age }));

  return { players, bullets, pickups: a.pickups };
}

/* ------------------------------ drawing ------------------------------ */
function drawGrid() {
  ctx.fillStyle = '#f6f6f3';
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  const grid = 100 * S.zoom;
  const ox = ((-S.camera.x * S.zoom + innerWidth / 2) % grid + grid) % grid;
  const oy = ((-S.camera.y * S.zoom + innerHeight / 2) % grid + grid) % grid;
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = ox; x < innerWidth; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, innerHeight); }
  for (let y = oy; y < innerHeight; y += grid) { ctx.moveTo(0, y); ctx.lineTo(innerWidth, y); }
  ctx.stroke();

  const tl = worldToScreen(0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(tl.x, tl.y, S.world * S.zoom, S.world * S.zoom);
}

function drawWalls() {
  for (const r of MT.MAP) {
    const p = worldToScreen(r.x, r.y);
    const w = r.w * S.zoom;
    const h = r.h * S.zoom;
    if (p.x + w < 0 || p.y + h < 0 || p.x > innerWidth || p.y > innerHeight) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(p.x + 4, p.y + 5, w, h);
    ctx.fillStyle = '#e6e6e1';
    ctx.fillRect(p.x, p.y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, w, h);
  }
}

function drawPickups(pickups) {
  const t = Date.now() / 1000;
  for (const pk of pickups) {
    const p = worldToScreen(pk.x, pk.y);
    const bob = Math.sin(t * 3 + pk.x) * 3;
    const r = CFG.PICKUP_RADIUS * S.zoom;
    ctx.save();
    ctx.translate(p.x, p.y + bob);
    ctx.rotate(Math.sin(t * 1.5 + pk.y) * 0.12);
    ctx.fillStyle = pk.kind === 'health' ? '#047857' : '#1d4ed8';
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.1)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = pk.kind === 'health' ? '+' : (WEAPONS[pk.kind] ? WEAPONS[pk.kind].name[0] : '?');
    ctx.fillText(label, 0, 1);
    ctx.restore();
  }
}

function drawPlayer(p, isMe) {
  const pos = worldToScreen(p.x, p.y);
  const size = 52 * S.zoom;
  if (pos.x < -80 || pos.y < -80 || pos.x > innerWidth + 80 || pos.y > innerHeight + 80) return;

  // Shadow grounds the sprite so it reads as an object, not a decal.
  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  ctx.beginPath();
  ctx.ellipse(pos.x + 3, pos.y + 6, size * 0.34, size * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();

  if (p.invuln) {
    ctx.strokeStyle = 'rgba(29,78,216,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(p.aim - CFG.SPRITE_ANGLE);
  if (sprite.complete && sprite.naturalWidth) {
    ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = p.color;
    ctx.fillRect(-size / 3, -size / 3, size * 0.66, size * 0.66);
  }
  ctx.restore();

  // Team-less colour tag, so you can tell people apart at a glance.
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, Math.max(3, 4.5 * S.zoom), 0, Math.PI * 2);
  ctx.fill();

  const ratio = MT.clamp(p.health / CFG.MAX_HEALTH, 0, 1);
  if (ratio < 1) {
    const w = 42 * S.zoom;
    const h = 5 * S.zoom;
    const by = pos.y + size * 0.55;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(pos.x - w / 2, by, w, h);
    ctx.fillStyle = ratio > 0.5 ? '#047857' : ratio > 0.25 ? '#a16207' : '#be123c';
    ctx.fillRect(pos.x - w / 2, by, w * ratio, h);
  }

  ctx.fillStyle = isMe ? '#111' : 'rgba(17,17,17,0.72)';
  ctx.font = `${isMe ? 600 : 400} ${Math.round(12 * S.zoom + 1)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(p.name + (p.bot ? ' · bot' : ''), pos.x, pos.y - size * 0.6);
}

function drawBullets(bullets) {
  for (const b of bullets) {
    const p = worldToScreen(b.x, b.y);
    if (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40) continue;
    const len = (b.w === 'railgun' ? 46 : 20) * S.zoom;
    const tailX = p.x - Math.cos(b.a) * len;
    const tailY = p.y - Math.sin(b.a) * len;
    const grad = ctx.createLinearGradient(tailX, tailY, p.x, p.y);
    grad.addColorStop(0, 'rgba(17,17,17,0)');
    grad.addColorStop(1, 'rgba(17,17,17,0.9)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.5, b.r * S.zoom);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

function drawParticles(dt) {
  for (let i = S.particles.length - 1; i >= 0; i--) {
    const q = S.particles[i];
    q.life += dt;
    if (q.life >= q.ttl) { S.particles.splice(i, 1); continue; }
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.vx *= 0.93;
    q.vy *= 0.93;
    const p = worldToScreen(q.x, q.y);
    ctx.globalAlpha = 1 - q.life / q.ttl;
    ctx.fillStyle = q.color;
    ctx.fillRect(p.x, p.y, q.size * S.zoom, q.size * S.zoom);
  }
  ctx.globalAlpha = 1;

  for (let i = S.tracers.length - 1; i >= 0; i--) {
    const t = S.tracers[i];
    t.life += dt;
    if (t.life >= t.ttl) { S.tracers.splice(i, 1); continue; }
    const a = worldToScreen(t.x + Math.cos(t.a) * 22, t.y + Math.sin(t.a) * 22);
    const b = worldToScreen(t.x + Math.cos(t.a) * (22 + t.len), t.y + Math.sin(t.a) * (22 + t.len));
    ctx.globalAlpha = 1 - t.life / t.ttl;
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 4 * S.zoom;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = S.damageNumbers.length - 1; i >= 0; i--) {
    const d = S.damageNumbers[i];
    d.life += dt;
    if (d.life > 0.7) { S.damageNumbers.splice(i, 1); continue; }
    const p = worldToScreen(d.x, d.y);
    ctx.globalAlpha = 1 - d.life / 0.7;
    ctx.fillStyle = d.mine ? '#be123c' : 'rgba(17,17,17,0.5)';
    ctx.font = `bold ${Math.round((d.mine ? 16 : 13) * S.zoom + 2)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(d.v, p.x, p.y - 12 - d.life * 40);
  }
  ctx.globalAlpha = 1;
}

function drawCrosshair() {
  const x = S.mouse.x;
  const y = S.mouse.y;
  const spread = S.hitMarker > 0 ? 5 + S.hitMarker * 6 : 5;
  ctx.strokeStyle = S.hitMarker > 0 ? 'rgba(190,18,60,0.95)' : 'rgba(17,17,17,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    ctx.moveTo(x + dx * spread, y + dy * spread);
    ctx.lineTo(x + dx * (spread + 7), y + dy * (spread + 7));
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(17,17,17,0.9)';
  ctx.fillRect(x - 1, y - 1, 2, 2);
}

function drawMinimap(players) {
  const size = 148;
  const pad = 16;
  const x0 = innerWidth - size - pad;
  const y0 = innerHeight - size - pad;
  const k = size / S.world;

  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.fillRect(x0, y0, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, size, size);

  ctx.fillStyle = 'rgba(0,0,0,0.13)';
  for (const r of MT.MAP) ctx.fillRect(x0 + r.x * k, y0 + r.y * k, r.w * k, r.h * k);

  for (const pk of S.pickups) {
    ctx.fillStyle = pk.kind === 'health' ? '#047857' : '#1d4ed8';
    ctx.fillRect(x0 + pk.x * k - 1.5, y0 + pk.y * k - 1.5, 3, 3);
  }
  for (const p of players) {
    if (!p.alive) continue;
    const me = p.id === S.id;
    ctx.fillStyle = me ? '#be123c' : p.color;
    ctx.beginPath();
    ctx.arc(x0 + p.x * k, y0 + p.y * k, me ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function updateHud() {
  const ratio = MT.clamp(S.health / CFG.MAX_HEALTH, 0, 1);
  healthFill.style.width = `${ratio * 100}%`;
  healthFill.style.background = ratio > 0.5 ? '#047857' : ratio > 0.25 ? '#a16207' : '#be123c';
  healthNum.textContent = Math.max(0, Math.round(S.health));

  const w = WEAPONS[S.weapon] || WEAPONS.pistol;
  weaponName.textContent = w.name;
  ammoText.textContent = S.hud.reserve < 0
    ? `${S.hud.mag} / ∞`
    : `${S.hud.mag} / ${S.hud.reserve}`;

  if (S.hud.reloading > 0) {
    reloadWrap.classList.add('show');
    reloadFill.style.width = `${(1 - S.hud.reloading / S.hud.reloadTime) * 100}%`;
  } else {
    reloadWrap.classList.remove('show');
  }

  const dashReady = 1 - MT.clamp(S.self.dashCooldown / CFG.DASH_COOLDOWN, 0, 1);
  dashFill.style.width = `${dashReady * 100}%`;
  dashFill.style.background = dashReady >= 1 ? '#1d4ed8' : 'rgba(0,0,0,0.3)';

  hurtVignette.style.opacity = String(S.hurtFlash * 0.55);

  if (!S.alive && S.joined) {
    centerMsg.classList.add('show');
    centerMsg.innerHTML = `<span class="big">respawning</span><span class="small">${S.hud.respawnIn.toFixed(1)}s</span>`;
  } else {
    centerMsg.classList.remove('show');
  }
}

function updateScoreboard(players) {
  if (!S.showScores) return;
  const rows = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  scoreBody.innerHTML = rows.map((p) => `
    <tr class="${p.id === S.id ? 'me' : ''}">
      <td><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.bot ? ' <i>bot</i>' : ''}</td>
      <td>${p.kills}</td><td>${p.deaths}</td><td>${p.streak}</td>
    </tr>`).join('');
}

/* ------------------------------- frame ------------------------------- */
let lastFrame = performance.now();
let accumulator = 0;
const FIXED = 1 / 60;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // Run the local simulation on a fixed step so prediction stays stable
  // regardless of the monitor's refresh rate.
  if (S.joined) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED && steps++ < 5) {
      stepLocal(FIXED);
      accumulator -= FIXED;
    }
  }

  const speed = Math.hypot(S.self.vx, S.self.vy);
  const wantZoom = baseZoom() * (1 - MT.clamp(speed / CFG.DASH_SPEED, 0, 1) * 0.07);
  S.zoom += (wantZoom - S.zoom) * (1 - Math.pow(0.02, dt));

  S.correction.x *= Math.pow(0.0025, dt);
  S.correction.y *= Math.pow(0.0025, dt);
  S.hurtFlash = Math.max(0, S.hurtFlash - dt * 2.2);
  S.hitMarker = Math.max(0, S.hitMarker - dt * 4);
  S.shake = Math.max(0, S.shake - dt * 28);

  const view = interpolated();
  S.players = view.players;
  S.pickups = view.pickups;
  S.bullets = view.bullets;

  // Camera: follow the predicted position and lean slightly toward the
  // cursor, so you see more of where you are aiming.
  if (S.joined) {
    const lead = 0.16;
    const mw = S.usingTouch
      ? { x: S.self.x + Math.cos(S.self.aim) * 330, y: S.self.y + Math.sin(S.self.aim) * 330 }
      : screenToWorld(S.mouse.x, S.mouse.y);
    const tx = S.self.x + S.correction.x + (mw.x - S.self.x) * lead;
    const ty = S.self.y + S.correction.y + (mw.y - S.self.y) * lead;
    const k = 1 - Math.pow(0.0001, dt);
    S.camera.x += (tx - S.camera.x) * k;
    S.camera.y += (ty - S.camera.y) * k;

    // Keep the arena filling the screen instead of letting you drift off into
    // empty space at the edges.
    const halfW = innerWidth / 2 / S.zoom;
    const halfH = innerHeight / 2 / S.zoom;
    const margin = 90;
    S.camera.x = halfW * 2 > S.world + margin * 2
      ? S.world / 2
      : MT.clamp(S.camera.x, halfW - margin, S.world - halfW + margin);
    S.camera.y = halfH * 2 > S.world + margin * 2
      ? S.world / 2
      : MT.clamp(S.camera.y, halfH - margin, S.world - halfH + margin);
  } else {
    const t = Date.now() / 9000;
    S.camera.x = S.world / 2 + Math.cos(t) * S.world * 0.22;
    S.camera.y = S.world / 2 + Math.sin(t * 1.3) * S.world * 0.22;
  }

  ctx.save();
  if (S.shake > 0.1) {
    ctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
  }

  drawGrid();
  drawWalls();
  drawPickups(S.pickups);
  drawBullets(view.bullets);

  for (const p of S.players) {
    if (!p.alive) continue;
    if (p.id === S.id) {
      if (S.alive) {
        drawPlayer({ ...p, x: S.self.x + S.correction.x, y: S.self.y + S.correction.y, aim: S.self.aim, health: S.health }, true);
      }
    } else {
      drawPlayer(p, false);
    }
  }

  drawParticles(dt);
  ctx.restore();

  if (S.joined) {
    drawMinimap(S.players);
    if (S.alive && !S.usingTouch) drawCrosshair();
  }
  updateHud();
  updateScoreboard(S.players);
}

// Exposed for debugging and automated smoke tests.
window.__dbg = S;

frame();
