const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const WORLD = 3200;
const PLAYER_RADIUS = 18;
const SPEED = 270;
const BULLET_SPEED = 1100;
const BULLET_LIFE = 1.15;
const FIRE_COOLDOWN = 220;
const DAMAGE = 34;

app.use(express.static(path.join(__dirname, 'public')));

const players = new Map();
const bullets = new Map();
let bulletSeq = 1;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function spawnPoint() {
  return {
    x: 240 + Math.random() * (WORLD - 480),
    y: 240 + Math.random() * (WORLD - 480),
  };
}

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ['#111111', '#2b2b2b', '#444444', '#666666'][hash % 4];
}

function cleanName(raw) {
  const value = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 18);
  return value || 'Mouse';
}

function snapshot() {
  return {
    worldSize: WORLD,
    players: [...players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      health: p.health,
      maxHealth: p.maxHealth,
      alive: p.alive,
      color: p.color,
    })),
    bullets: [...bullets.entries()].map(([id, b]) => ({
      id,
      x: b.x,
      y: b.y,
      angle: b.angle,
    })),
  };
}

function removePlayer(id, silent = false) {
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  if (!silent) {
    io.emit('announcement', { type: 'leave', text: `${p.name} left` });
  }
}

function kick(socket, reason) {
  const p = players.get(socket.id);
  if (!p || p.kicked) return;
  p.kicked = true;
  socket.emit('dead', { reason });
  setTimeout(() => {
    if (socket.connected) socket.disconnect(true);
  }, 180);
}

function kill(victimId, killerId) {
  const victim = players.get(victimId);
  if (!victim || !victim.alive) return;
  victim.alive = false;
  victim.health = 0;

  const killer = killerId ? players.get(killerId) : null;
  io.emit('announcement', {
    type: 'kill',
    text: `${killer ? killer.name : 'mouse'} got ${victim.name}`,
  });

  const socket = io.sockets.sockets.get(victimId);
  if (socket) kick(socket, 'You were eliminated.');
}

io.on('connection', (socket) => {
  socket.emit('hello', { worldSize: WORLD });

  socket.on('join', ({ name } = {}) => {
    const clean = cleanName(name);
    const spawn = spawnPoint();
    players.set(socket.id, {
      name: clean,
      x: spawn.x,
      y: spawn.y,
      angle: Math.random() * Math.PI * 2,
      color: colorFor(clean),
      health: 100,
      maxHealth: 100,
      alive: true,
      input: { up: false, down: false, left: false, right: false, fire: false },
      lastShot: 0,
      kicked: false,
    });

    socket.emit('joined', { id: socket.id, name: clean, worldSize: WORLD, spawn });
    io.emit('announcement', { type: 'join', text: `${clean} joined` });
  });

  socket.on('input', (input = {}) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    p.input.up = !!input.up;
    p.input.down = !!input.down;
    p.input.left = !!input.left;
    p.input.right = !!input.right;
    p.input.fire = !!input.fire;
    if (Number.isFinite(input.angle)) p.angle = input.angle;
  });

  socket.on('disconnect', () => removePlayer(socket.id));
});

let last = Date.now();
let snapshotTimer = 0;

function tick() {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;

  for (const [id, p] of players) {
    if (!p.alive) continue;

    const forward = (p.input.up ? 1 : 0) - (p.input.down ? 1 : 0);
    const strafe = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const sin = Math.sin(p.angle);
    const cos = Math.cos(p.angle);

    let vx = cos * forward + Math.cos(p.angle + Math.PI / 2) * strafe;
    let vy = sin * forward + Math.sin(p.angle + Math.PI / 2) * strafe;
    const len = Math.hypot(vx, vy);

    if (len > 0) {
      vx /= len;
      vy /= len;
      p.x = clamp(p.x + vx * SPEED * dt, PLAYER_RADIUS, WORLD - PLAYER_RADIUS);
      p.y = clamp(p.y + vy * SPEED * dt, PLAYER_RADIUS, WORLD - PLAYER_RADIUS);
    }

    if (p.input.fire && now - p.lastShot >= FIRE_COOLDOWN) {
      p.lastShot = now;
      const angle = p.angle;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      bullets.set(String(bulletSeq++), {
        ownerId: id,
        x: p.x + dx * 28,
        y: p.y + dy * 28,
        dx: dx * BULLET_SPEED,
        dy: dy * BULLET_SPEED,
        angle,
        age: 0,
      });
    }
  }

  for (const [bulletId, b] of bullets) {
    b.age += dt;
    b.x += b.dx * dt;
    b.y += b.dy * dt;

    if (b.age > BULLET_LIFE || b.x < -20 || b.y < -20 || b.x > WORLD + 20 || b.y > WORLD + 20) {
      bullets.delete(bulletId);
      continue;
    }

    for (const [playerId, p] of players) {
      if (!p.alive || playerId === b.ownerId) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) <= PLAYER_RADIUS + 5) {
        bullets.delete(bulletId);
        p.health -= DAMAGE;
        if (p.health <= 0) kill(playerId, b.ownerId);
        break;
      }
    }
  }

  if (now - snapshotTimer > 50) {
    io.emit('state', snapshot());
    snapshotTimer = now;
  }
}

setInterval(tick, 1000 / 60);

server.listen(PORT, () => console.log(`MouseThing running on ${PORT}`));
