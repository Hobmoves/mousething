const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const ui = document.getElementById("ui");
const loginPanel = document.getElementById("loginPanel");
const deadPanel = document.getElementById("deadPanel");
const joinForm = document.getElementById("joinForm");
const nameInput = document.getElementById("nameInput");
const restartBtn = document.getElementById("restartBtn");

const myNameEl = document.getElementById("myName");
const myHealthEl = document.getElementById("myHealth");
const myKillsEl = document.getElementById("myKills");

const socket = io();

const keys = { up: false, down: false, left: false, right: false };
let joined = false;
let dead = false;
let myId = null;
let myName = "";
let world = { width: 3200, height: 3200 };
let state = { players: [], bullets: [] };
let screenW = 0;
let screenH = 0;

const localCursor = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
};

const mouseImg = new Image();
mouseImg.src = "/mouse.png";

function resize() {
  const dpr = window.devicePixelRatio || 1;
  screenW = window.innerWidth;
  screenH = window.innerHeight;
  canvas.width = Math.floor(screenW * dpr);
  canvas.height = Math.floor(screenH * dpr);
  canvas.style.width = screenW + "px";
  canvas.style.height = screenH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function sendInput() {
  if (!joined || dead) return;
  socket.emit("input", keys);
}

function updateKeys() {
  keys.up = keys.w || keys.W || keys.ArrowUp || false;
  keys.down = keys.s || keys.S || keys.ArrowDown || false;
  keys.left = keys.a || keys.A || keys.ArrowLeft || false;
  keys.right = keys.d || keys.D || keys.ArrowRight || false;
}

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") keys.up = true;
  if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") keys.down = true;
  if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") keys.left = true;
  if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") keys.right = true;
  updateKeys();
  sendInput();
});

window.addEventListener("keyup", (e) => {
  if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") keys.up = false;
  if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") keys.down = false;
  if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") keys.left = false;
  if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") keys.right = false;
  updateKeys();
  sendInput();
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function joinGame(name) {
  myName = String(name || "").trim().slice(0, 16);
  if (!myName) return;
  socket.emit("join", { name: myName });
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  joinGame(nameInput.value);
});

restartBtn.addEventListener("click", () => {
  deadPanel.classList.add("hidden");
  loginPanel.classList.remove("hidden");
  ui.style.display = "grid";
  joined = false;
  dead = false;
  socket.connect();
  nameInput.focus();
});

socket.on("joinRejected", ({ reason }) => {
  alert(reason || "Couldn't join.");
});

socket.on("joined", ({ id, world: w }) => {
  joined = true;
  dead = false;
  myId = id;
  world = w;
  ui.style.display = "none";
});

socket.on("state", (snapshot) => {
  state = snapshot;
  if (!myId) return;
  const me = state.players.find((p) => p.id === myId);
  if (me) {
    myHealthEl.textContent = `${Math.max(0, Math.round(me.health))} HP`;
    myKillsEl.textContent = `${me.kills} Kills`;
    myNameEl.textContent = me.name;
  }
});

socket.on("dead", () => {
  dead = true;
  joined = false;
  socket.disconnect();
  ui.style.display = "grid";
  loginPanel.classList.add("hidden");
  deadPanel.classList.remove("hidden");
});

function worldToScreen(x, y, me) {
  return {
    x: x - me.x + screenW / 2,
    y: y - me.y + screenH / 2,
  };
}

function drawGrid(me) {
  const step = 80;
  const ox = (screenW / 2 - me.x) % step;
  const oy = (screenH / 2 - me.y) % step;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = 1;

  for (let x = ox; x < screenW; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, screenH);
    ctx.stroke();
  }
  for (let y = oy; y < screenH; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(screenW, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArenaFrame(me) {
  const topLeft = worldToScreen(0, 0, me);
  const bottomRight = worldToScreen(world.width, world.height, me);
  ctx.save();
  ctx.strokeStyle = "rgba(140,240,166,0.15)";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.restore();
}

function drawPlayer(p, me) {
  const pos = worldToScreen(p.x, p.y, me);
  const size = 48;
  const angle = p.angle || 0;

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(angle);

  ctx.globalAlpha = p.id === myId ? 1 : 0.9;
  ctx.drawImage(mouseImg, -size/2, -size/2, size, size);

  // tiny gun barrel
  ctx.strokeStyle = "rgba(240,248,255,0.9)";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.lineTo(42, 0);
  ctx.stroke();

  // nameplate
  ctx.rotate(-angle);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const text = p.name;
  const tw = ctx.measureText(text).width;
  ctx.fillRect(-tw/2 - 8, -46, tw + 16, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, 0, -30);

  // health bar
  const barW = 44;
  const barH = 6;
  const hp = Math.max(0, Math.min(1, p.health / p.maxHealth));
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(-barW/2, 34, barW, barH);
  ctx.fillStyle = hp > 0.5 ? "#8cf0a6" : hp > 0.2 ? "#ffd166" : "#ff5c5c";
  ctx.fillRect(-barW/2, 34, barW * hp, barH);

  ctx.restore();
}

function drawBullets(me) {
  ctx.save();
  for (const b of state.bullets) {
    const pos = worldToScreen(b.x, b.y, me);
    ctx.fillStyle = "#ffef9f";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCursor() {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.drawImage(mouseImg, localCursor.x - 16, localCursor.y - 16, 32, 32);
  ctx.restore();
}

function tick() {
  ctx.clearRect(0, 0, screenW, screenH);

  const me = state.players.find((p) => p.id === myId);
  if (me) {
    drawGrid(me);
    drawArenaFrame(me);
    drawBullets(me);

    for (const p of state.players) drawPlayer(p, me);

    // local fake cursor follows WASD and is shown on top of the game.
    drawCursor();
  } else {
    ctx.fillStyle = "#e8eef4";
    ctx.font = "24px Inter, sans-serif";
    ctx.fillText("Waiting to join…", 24, 40);
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener("mousemove", (e) => {
  localCursor.x = e.clientX;
  localCursor.y = e.clientY;
});

window.addEventListener("click", () => {
  if (!joined || dead) return;
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  const angle = Math.atan2(localCursor.y - screenH / 2, localCursor.x - screenW / 2);
  socket.emit("shoot", { angle });
});

function moveLocalCursor() {
  const speed = 7;
  if (keys.left) localCursor.x -= speed;
  if (keys.right) localCursor.x += speed;
  if (keys.up) localCursor.y -= speed;
  if (keys.down) localCursor.y += speed;
  localCursor.x = clamp(localCursor.x, 0, screenW);
  localCursor.y = clamp(localCursor.y, 0, screenH);
  requestAnimationFrame(moveLocalCursor);
}
requestAnimationFrame(moveLocalCursor);

// keep cursor image hidden until in-game, but browser cursor hidden on canvas anyway
nameInput.focus();
