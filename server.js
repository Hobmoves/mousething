const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const TICK_RATE = 20;
const WORLD = { width: 3200, height: 3200 };
const PLAYER_RADIUS = 28;
const BULLET_RADIUS = 5;

const players = new Map();
const bullets = [];
const usedNames = new Set();

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function spawnPoint() {
  return {
    x: 200 + Math.random() * (WORLD.width - 400),
    y: 200 + Math.random() * (WORLD.height - 400),
  };
}

function normalizeAngle(a) {
  while (a < -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function broadcastState() {
  const snapshot = {
    world: WORLD,
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      angle: p.angle,
      health: p.health,
      maxHealth: p.maxHealth,
      kills: p.kills,
    })),
    bullets: bullets.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      angle: b.angle,
    })),
  };
  io.emit("state", snapshot);
}

function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  if (!victim) return;
  if (killerId && players.has(killerId)) {
    players.get(killerId).kills += 1;
  }
  victim.socket.emit("dead", {
    reason: "You got clipped.",
  });
  victim.socket.disconnect(true);
}

function update() {
  const dt = 1 / TICK_RATE;

  for (const p of players.values()) {
    const speed = p.speed;
    const dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      p.vx = (dx / len) * speed;
      p.vy = (dy / len) * speed;
      p.angle = Math.atan2(dy, dx);
    } else {
      p.vx *= 0.85;
      p.vy *= 0.85;
    }

    p.x = clamp(p.x + p.vx * dt, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
    p.y = clamp(p.y + p.vy * dt, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);
  }

  for (const b of bullets) {
    b.x += Math.cos(b.angle) * b.speed * dt;
    b.y += Math.sin(b.angle) * b.speed * dt;
    b.life -= dt;

    for (const p of players.values()) {
      if (p.id === b.ownerId) continue;
      const dist = Math.hypot(p.x - b.x, p.y - b.y);
      if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
        p.health -= b.damage;
        b.life = 0;
        if (p.health <= 0) {
          killPlayer(p.id, b.ownerId);
        }
        break;
      }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    if (b.life <= 0 || b.x < -50 || b.y < -50 || b.x > WORLD.width + 50 || b.y > WORLD.height + 50) {
      bullets.splice(i, 1);
    }
  }

  broadcastState();
}

io.on("connection", (socket) => {
  socket.on("join", ({ name }) => {
    name = String(name || "").trim().slice(0, 16);
    if (!name) {
      socket.emit("joinRejected", { reason: "Pick a name." });
      return;
    }
    if (usedNames.has(name.toLowerCase())) {
      socket.emit("joinRejected", { reason: "That name is taken." });
      return;
    }

    usedNames.add(name.toLowerCase());
    const spawn = spawnPoint();
    const id = makeId();
    const player = {
      id,
      socket,
      name,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      angle: 0,
      speed: 320,
      health: 100,
      maxHealth: 100,
      kills: 0,
      input: { up: false, down: false, left: false, right: false },
    };

    players.set(id, player);
    socket.data.playerId = id;

    socket.emit("joined", {
      id,
      world: WORLD,
    });
  });

  socket.on("input", (input) => {
    const id = socket.data.playerId;
    if (!id || !players.has(id)) return;
    const p = players.get(id);
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
    };
  });

  socket.on("shoot", ({ angle }) => {
    const id = socket.data.playerId;
    if (!id || !players.has(id)) return;
    const p = players.get(id);
    const a = normalizeAngle(Number(angle) || 0);
    bullets.push({
      id: makeId(),
      ownerId: p.id,
      x: p.x + Math.cos(a) * 34,
      y: p.y + Math.sin(a) * 34,
      angle: a,
      speed: 980,
      damage: 20,
      life: 1.4,
    });
  });

  socket.on("disconnect", () => {
    const id = socket.data.playerId;
    if (id && players.has(id)) {
      const name = players.get(id).name.toLowerCase();
      usedNames.delete(name);
      players.delete(id);
    }
  });
});

setInterval(update, 1000 / TICK_RATE);

server.listen(process.env.PORT || 3000, () => {
  console.log("Mouse gun arena running on http://localhost:" + (process.env.PORT || 3000));
});
