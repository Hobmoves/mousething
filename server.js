const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const MT = require('./public/shared.js');

const { CFG, WEAPONS, WEAPON_DROPS, clamp } = MT;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MIN_COMBATANTS = 5; // top the arena up with bots so it is never empty

app.use(express.static(path.join(__dirname, 'public')));

const players = new Map();
const bullets = new Map();
const pickups = new Map();
let seq = 1;
let events = [];
let pickupTimer = 0;

const BOT_NAMES = [
  'Ctrl', 'Alt', 'Esc', 'Tab', 'Shift', 'Caps', 'Del', 'Fn',
  'Scrollbar', 'Doubleclick', 'Dragbox', 'I-Beam',
];

function pushEvent(e) {
  if (events.length < 120) events.push(e);
}

function cleanName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 16) || 'Mouse';
}

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const palette = ['#1b1b1b', '#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#a16207'];
  return palette[hash % palette.length];
}

/* Pick an open spot, biased away from whoever is already alive. */
function spawnPoint() {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 24; i++) {
    const x = 120 + Math.random() * (CFG.WORLD - 240);
    const y = 120 + Math.random() * (CFG.WORLD - 240);
    if (MT.pointInWalls(x, y, CFG.PLAYER_RADIUS + 12)) continue;
    let nearest = Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue;
      nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y));
    }
    const score = nearest === Infinity ? 1e6 - i : nearest;
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return best || { x: CFG.WORLD / 2, y: CFG.WORLD / 2 };
}

function makePlayer(name, bot) {
  const spawn = spawnPoint();
  return {
    name,
    color: colorFor(name + (bot ? '~' : '')),
    bot: !!bot,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    aim: Math.random() * Math.PI * 2,
    health: CFG.MAX_HEALTH,
    alive: true,
    respawnAt: 0,
    invulnUntil: Date.now() + CFG.SPAWN_PROTECT * 1000,
    lastHurt: 0,
    dashTime: 0,
    dashCooldown: 0,
    weapon: 'pistol',
    mag: WEAPONS.pistol.mag,
    reserve: Infinity,
    reloadEnd: 0,
    lastShot: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    best: 0,
    cmd: { mx: 0, my: 0, aim: 0, fire: false, dash: false, reload: false, seq: 0 },
    ack: 0,
    lastCmdAt: Date.now(),
    ai: bot ? {
      targetId: null, decideAt: 0, strafe: Math.random() < 0.5 ? 1 : -1,
      strafeAt: 0, skill: 0.3 + Math.random() * 0.45, aimOffset: 0, detour: null,
      burstUntil: 0, restUntil: 0,
    } : null,
  };
}

function giveWeapon(p, id) {
  const w = WEAPONS[id];
  if (!w) return;
  p.weapon = id;
  p.mag = w.mag;
  p.reserve = w.reserve;
  p.reloadEnd = 0;
}

function respawn(p) {
  const spawn = spawnPoint();
  p.x = spawn.x;
  p.y = spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.health = CFG.MAX_HEALTH;
  p.alive = true;
  p.dashTime = 0;
  p.dashCooldown = 0;
  p.invulnUntil = Date.now() + CFG.SPAWN_PROTECT * 1000;
  p.lastHurt = 0;
  giveWeapon(p, 'pistol');
  pushEvent({ t: 'spawn', x: p.x, y: p.y });
}

function kill(victimId, killerId) {
  const victim = players.get(victimId);
  if (!victim || !victim.alive) return;
  victim.alive = false;
  victim.health = 0;
  victim.deaths++;
  victim.streak = 0;
  victim.respawnAt = Date.now() + CFG.RESPAWN_TIME * 1000;

  const killer = killerId && killerId !== victimId ? players.get(killerId) : null;
  if (killer) {
    killer.kills++;
    killer.streak++;
    killer.best = Math.max(killer.best, killer.streak);
    // A kill tops you back up a little -- rewards pushing, not camping.
    killer.health = Math.min(CFG.MAX_HEALTH, killer.health + 25);
  }

  pushEvent({ t: 'death', x: victim.x, y: victim.y, color: victim.color });
  io.emit('feed', {
    killer: killer ? killer.name : null,
    victim: victim.name,
    weapon: killer ? killer.weapon : null,
    streak: killer ? killer.streak : 0,
  });
  // Drop the good gun where you fell.
  if (victim.weapon !== 'pistol' && pickups.size < CFG.MAX_PICKUPS + 3) {
    pickups.set(String(seq++), { kind: victim.weapon, x: victim.x, y: victim.y, born: Date.now() });
  }
}

function damage(p, amount, sourceId) {
  if (!p.alive || Date.now() < p.invulnUntil) return;
  p.health -= amount;
  p.lastHurt = Date.now();
  if (p.health <= 0) kill(getId(p), sourceId);
}

function getId(target) {
  for (const [id, p] of players) if (p === target) return id;
  return null;
}

function spawnPickup() {
  if (pickups.size >= CFG.MAX_PICKUPS) return;
  const spot = spawnPoint();
  const kind = Math.random() < 0.4
    ? 'health'
    : WEAPON_DROPS[Math.floor(Math.random() * WEAPON_DROPS.length)];
  pickups.set(String(seq++), { kind, x: spot.x, y: spot.y, born: Date.now() });
}

function fire(id, p, now) {
  const w = WEAPONS[p.weapon];
  if (now < p.reloadEnd) return;

  if (p.mag <= 0) {
    if (p.reserve <= 0 && p.weapon !== 'pistol') { giveWeapon(p, 'pistol'); return; }
    p.reloadEnd = now + w.reload * 1000;
    pushEvent({ t: 'reload', x: p.x, y: p.y });
    return;
  }
  if (now - p.lastShot < w.cooldown * 1000) return;

  p.lastShot = now;
  p.mag--;
  if (p.weapon !== 'pistol') p.reserve--;

  for (let i = 0; i < w.pellets; i++) {
    const spread = (Math.random() - 0.5) * 2 * w.spread;
    const angle = p.aim + spread;
    const speedJitter = w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1;
    bullets.set(String(seq++), {
      ownerId: id,
      x: p.x + Math.cos(p.aim) * 26,
      y: p.y + Math.sin(p.aim) * 26,
      dx: Math.cos(angle) * w.speed * speedJitter,
      dy: Math.sin(angle) * w.speed * speedJitter,
      angle,
      age: 0,
      life: w.life,
      dmg: w.dmg,
      radius: w.radius,
      weapon: p.weapon,
    });
  }

  // Recoil pushes you back -- the shotgun genuinely shoves you.
  p.vx -= Math.cos(p.aim) * w.kick * 22;
  p.vy -= Math.sin(p.aim) * w.kick * 22;

  pushEvent({ t: 'shot', x: p.x, y: p.y, a: p.aim, w: p.weapon });
  if (p.mag <= 0 && (p.reserve > 0 || p.weapon === 'pistol')) {
    p.reloadEnd = now + w.reload * 1000;
  }
}

/* ------------------------------ bots ------------------------------ */

function driveBot(id, p, dt, now) {
  const ai = p.ai;
  const cmd = p.cmd;
  cmd.fire = false;
  cmd.dash = false;

  if (now > ai.decideAt) {
    ai.decideAt = now + 220 + Math.random() * 200;
    let bestId = null;
    let bestScore = Infinity;
    for (const [oid, o] of players) {
      if (oid === id || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      const visible = !MT.segmentBlocked(p.x, p.y, o.x, o.y);
      // Slightly prefer other bots, so a lone human does not get focused by
      // the whole arena the moment they spawn.
      const score = d * (visible ? 1 : 2.6) * (o.bot ? 1 : 1.3);
      if (score < bestScore) { bestScore = score; bestId = oid; }
    }
    ai.targetId = bestId;
    ai.aimOffset = (Math.random() - 0.5) * (1 - ai.skill) * 0.85;
  }
  if (now > ai.strafeAt) {
    ai.strafeAt = now + 700 + Math.random() * 1200;
    ai.strafe = Math.random() < 0.5 ? 1 : -1;
  }

  // Low on health? Go shopping.
  let goal = null;
  if (p.health < 45) {
    let bestD = 700;
    for (const pk of pickups.values()) {
      if (pk.kind !== 'health') continue;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bestD) { bestD = d; goal = pk; }
    }
  }
  if (!goal && p.weapon === 'pistol') {
    let bestD = 480;
    for (const pk of pickups.values()) {
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      if (d < bestD) { bestD = d; goal = pk; }
    }
  }

  const target = ai.targetId ? players.get(ai.targetId) : null;
  let dirX = 0;
  let dirY = 0;

  if (goal) {
    dirX = goal.x - p.x;
    dirY = goal.y - p.y;
  } else if (target && target.alive) {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const want = p.weapon === 'shotgun' ? 220 : 430;
    const push = clamp((dist - want) / 260, -1, 1);
    dirX = (dx / dist) * push + (-dy / dist) * ai.strafe * 0.85;
    dirY = (dy / dist) * push + (dx / dist) * ai.strafe * 0.85;

    const visible = !MT.segmentBlocked(p.x, p.y, target.x, target.y);
    // Lead the shot by the bullet's travel time.
    const w = WEAPONS[p.weapon];
    const travel = dist / w.speed;
    const aimX = target.x + target.vx * travel * ai.skill;
    const aimY = target.y + target.vy * travel * ai.skill;
    const wanted = Math.atan2(aimY - p.y, aimX - p.x) + ai.aimOffset;
    const turn = (2.5 + ai.skill * 6) * dt;
    p.aim += clamp(MT.shortestAngle(p.aim, wanted), -turn, turn);

    if (now > ai.restUntil && now > ai.burstUntil) {
      ai.burstUntil = now + 350 + Math.random() * 550 * ai.skill;
      ai.restUntil = ai.burstUntil + 350 + (1 - ai.skill) * 700;
    }
    const aligned = Math.abs(MT.shortestAngle(p.aim, wanted)) < 0.16;
    if (visible && aligned && dist < 900 && now < ai.burstUntil) cmd.fire = true;
    if (visible && dist > 600 && p.dashCooldown <= 0 && Math.random() < 0.01) cmd.dash = true;
    if (now - p.lastHurt < 400 && p.dashCooldown <= 0 && Math.random() < 0.05) cmd.dash = true;
  } else {
    dirX = Math.cos(p.aim);
    dirY = Math.sin(p.aim);
  }

  // Crude but effective wall avoidance: if the way ahead is blocked, slide.
  const len = Math.hypot(dirX, dirY) || 1;
  dirX /= len;
  dirY /= len;
  if (MT.pointInWalls(p.x + dirX * 70, p.y + dirY * 70, CFG.PLAYER_RADIUS)) {
    const tx = -dirY * ai.strafe;
    const ty = dirX * ai.strafe;
    if (!MT.pointInWalls(p.x + tx * 70, p.y + ty * 70, CFG.PLAYER_RADIUS)) {
      dirX = tx; dirY = ty;
    } else {
      dirX = -dirX; dirY = -dirY;
      ai.strafe *= -1;
    }
  }

  cmd.mx = dirX;
  cmd.my = dirY;
  cmd.aim = p.aim;
  MT.stepMovement(p, cmd, dt);
}

function syncBots() {
  const humans = [...players.values()].filter((p) => !p.bot).length;
  const bots = [...players.entries()].filter(([, p]) => p.bot);
  if (humans === 0) {
    for (const [id] of bots) players.delete(id);
    return;
  }
  const want = clamp(MIN_COMBATANTS - humans, 0, 5);
  while (bots.length > want) {
    const [id] = bots.pop();
    players.delete(id);
  }
  let guard = 0;
  while (bots.length < want && guard++ < 8) {
    const used = new Set([...players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${seq}`;
    const id = `bot:${seq++}`;
    players.set(id, makePlayer(name, true));
    bots.push([id, players.get(id)]);
  }
}

/* ---------------------------- networking ---------------------------- */

function snapshot() {
  return {
    time: Date.now(),
    players: [...players.entries()].map(([id, p]) => ({
      id, name: p.name, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      aim: Math.round(p.aim * 1000) / 1000, health: p.health, alive: p.alive,
      color: p.color, kills: p.kills, deaths: p.deaths, streak: p.streak,
      weapon: p.weapon, bot: p.bot,
      invuln: Date.now() < p.invulnUntil,
    })),
    bullets: [...bullets.entries()].map(([id, b]) => ({
      id, x: Math.round(b.x), y: Math.round(b.y), dx: Math.round(b.dx),
      dy: Math.round(b.dy), a: Math.round(b.angle * 100) / 100, r: b.radius, w: b.weapon,
    })),
    pickups: [...pickups.entries()].map(([id, k]) => ({ id, kind: k.kind, x: k.x, y: k.y })),
    events,
  };
}

io.on('connection', (socket) => {
  socket.emit('hello', { world: CFG.WORLD, map: MT.MAP });

  socket.on('join', ({ name } = {}) => {
    if (players.has(socket.id)) return;
    const clean = cleanName(name);
    players.set(socket.id, makePlayer(clean, false));
    syncBots();
    socket.emit('joined', { id: socket.id, name: clean, world: CFG.WORLD });
    io.emit('feed', { join: clean });
  });

  socket.on('cmd', (c) => {
    const p = players.get(socket.id);
    if (!p || typeof c !== 'object' || c === null) return;

    const now = Date.now();
    // Trust the client's dt only as far as wall-clock allows, so a doctored
    // client cannot simply claim huge timesteps and outrun everyone.
    const allowance = ((now - p.lastCmdAt) / 1000) * 1.3 + 0.015;
    p.lastCmdAt = now;

    p.cmd.mx = clamp(Number(c.mx) || 0, -1, 1);
    p.cmd.my = clamp(Number(c.my) || 0, -1, 1);
    p.cmd.fire = !!c.fire;
    p.cmd.dash = !!c.dash;
    p.cmd.reload = !!c.reload;
    p.cmd.seq = Number(c.seq) || 0;
    if (Number.isFinite(c.aim)) p.cmd.aim = c.aim;

    if (p.alive) {
      const dt = clamp(Number(c.dt) || 0, 0, Math.min(CFG.MAX_CMD_DT, allowance));
      MT.stepMovement(p, p.cmd, dt);
      if (p.cmd.reload) requestReload(p, now);
    } else if (Number.isFinite(c.aim)) {
      p.aim = c.aim;
    }
    p.ack = p.cmd.seq;
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) io.emit('feed', { leave: p.name });
    players.delete(socket.id);
    syncBots();
  });
});

function requestReload(p, now) {
  const w = WEAPONS[p.weapon];
  if (now < p.reloadEnd || p.mag >= w.mag) return;
  if (p.weapon !== 'pistol' && p.reserve <= 0) return;
  p.reloadEnd = now + w.reload * 1000;
  pushEvent({ t: 'reload', x: p.x, y: p.y });
}

/* ------------------------------- tick ------------------------------- */

let last = Date.now();
let sinceSnapshot = 0;

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  for (const [id, p] of players) {
    if (!p.alive) {
      if (now >= p.respawnAt) respawn(p);
      continue;
    }

    if (p.bot) driveBot(id, p, dt, now);

    // Finish a reload.
    if (p.reloadEnd && now >= p.reloadEnd) {
      const w = WEAPONS[p.weapon];
      const need = w.mag - p.mag;
      const take = p.reserve === Infinity ? need : Math.min(need, p.reserve);
      p.mag += take;
      p.reloadEnd = 0;
      if (p.mag <= 0 && p.weapon !== 'pistol') giveWeapon(p, 'pistol');
    }

    if (p.cmd.fire) fire(id, p, now);

    if (p.health < CFG.MAX_HEALTH && now - p.lastHurt > CFG.REGEN_DELAY * 1000) {
      p.health = Math.min(CFG.MAX_HEALTH, p.health + CFG.REGEN_RATE * dt);
    }

    for (const [pid, pk] of pickups) {
      if (Math.hypot(pk.x - p.x, pk.y - p.y) > CFG.PICKUP_RADIUS + CFG.PLAYER_RADIUS) continue;
      if (pk.kind === 'health') {
        if (p.health >= CFG.MAX_HEALTH) continue;
        p.health = Math.min(CFG.MAX_HEALTH, p.health + CFG.HEALTH_PICKUP);
      } else {
        giveWeapon(p, pk.kind);
      }
      pickups.delete(pid);
      pushEvent({ t: 'pickup', x: pk.x, y: pk.y, kind: pk.kind, who: id });
    }
  }

  // Bullets: marched in short substeps so fast rounds cannot tunnel through
  // a player or a wall.
  for (const [bid, b] of bullets) {
    b.age += dt;
    if (b.age > b.life) { bullets.delete(bid); continue; }

    const dist = Math.hypot(b.dx, b.dy) * dt;
    const steps = Math.max(1, Math.ceil(dist / 11));
    const sdt = dt / steps;
    let dead = false;

    for (let s = 0; s < steps && !dead; s++) {
      b.x += b.dx * sdt;
      b.y += b.dy * sdt;

      if (b.x < 0 || b.y < 0 || b.x > CFG.WORLD || b.y > CFG.WORLD) {
        pushEvent({ t: 'spark', x: clamp(b.x, 0, CFG.WORLD), y: clamp(b.y, 0, CFG.WORLD), a: b.angle });
        dead = true;
        break;
      }
      if (MT.pointInWalls(b.x, b.y, 0)) {
        pushEvent({ t: 'spark', x: b.x, y: b.y, a: b.angle });
        dead = true;
        break;
      }
      for (const [pid, p] of players) {
        if (!p.alive || pid === b.ownerId || now < p.invulnUntil) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) > CFG.PLAYER_RADIUS + b.radius) continue;
        pushEvent({ t: 'hit', x: b.x, y: b.y, a: b.angle, dmg: b.dmg, color: p.color, by: b.ownerId });
        damage(p, b.dmg, b.ownerId);
        dead = true;
        break;
      }
    }
    if (dead) bullets.delete(bid);
  }

  pickupTimer += dt;
  if (pickupTimer > CFG.PICKUP_INTERVAL) {
    pickupTimer = 0;
    if (players.size > 0) spawnPickup();
  }

  sinceSnapshot += dt;
  if (sinceSnapshot >= 1 / CFG.SNAPSHOT_HZ) {
    sinceSnapshot = 0;
    const snap = snapshot();
    for (const [id, p] of players) {
      if (p.bot) continue;
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      const w = WEAPONS[p.weapon];
      socket.emit('state', {
        ...snap,
        ack: p.ack,
        self: {
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          dashTime: p.dashTime, dashCooldown: p.dashCooldown,
          mag: p.mag, reserve: p.reserve === Infinity ? -1 : p.reserve,
          magSize: w.mag, reloading: p.reloadEnd ? (p.reloadEnd - now) / 1000 : 0,
          reloadTime: w.reload, respawnIn: p.alive ? 0 : Math.max(0, (p.respawnAt - now) / 1000),
        },
      });
    }
    events = [];
  }
}

setInterval(tick, 1000 / CFG.TICK_HZ);

server.listen(PORT, () => console.log(`MouseThing running on ${PORT}`));
