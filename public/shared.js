/*
 * shared.js — the single source of truth for game rules and physics.
 *
 * Loaded by BOTH the server (require) and the browser (script tag -> window.MT).
 * Anything that affects where a player ends up MUST live here, so that the
 * client's prediction and the server's authoritative simulation produce
 * bit-for-bit identical results. That is what makes the controls feel instant
 * without letting clients cheat.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.MT = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  const WORLD = 2600;

  const CFG = {
    WORLD,
    TICK_HZ: 60,
    SNAPSHOT_HZ: 22,
    // Movement. Acceleration + linear damping gives weight without sludge.
    PLAYER_RADIUS: 19,
    ACCEL: 4200,
    FRICTION: 13,
    MAX_SPEED: 355,
    // Dash: a short burst you steer with, on a cooldown.
    DASH_SPEED: 1080,
    DASH_TIME: 0.13,
    DASH_COOLDOWN: 1.5,
    DASH_FRICTION: 3.5,
    // Health
    MAX_HEALTH: 100,
    REGEN_DELAY: 4.5,
    REGEN_RATE: 9,
    RESPAWN_TIME: 2.2,
    SPAWN_PROTECT: 1.2,
    // Networking
    MAX_CMD_DT: 0.05,
    INTERP_DELAY: 0.1,
    // Pickups
    PICKUP_RADIUS: 22,
    MAX_PICKUPS: 9,
    PICKUP_INTERVAL: 3.5,
    HEALTH_PICKUP: 35,
    // The arrow sprite points up-and-slightly-left in image space. This is the
    // angle it natively points at, so `render angle = aim - SPRITE_ANGLE`.
    // Do not "tune" this by feel -- it is measured from the artwork.
    SPRITE_ANGLE: -1.915,
  };

  const WEAPONS = {
    pistol: {
      id: 'pistol', name: 'Pointer', dmg: 24, cooldown: 0.25, speed: 1250,
      spread: 0.014, pellets: 1, mag: 14, reload: 1.0, reserve: Infinity,
      life: 1.3, radius: 5, kick: 1.1, shake: 2.2,
    },
    smg: {
      id: 'smg', name: 'Auto-Clicker', dmg: 13, cooldown: 0.068, speed: 1400,
      spread: 0.075, pellets: 1, mag: 34, reload: 1.35, reserve: 170,
      life: 0.95, radius: 4, kick: 0.55, shake: 1.5,
    },
    shotgun: {
      id: 'shotgun', name: 'Scattergun', dmg: 12, cooldown: 0.62, speed: 1080,
      spread: 0.2, pellets: 8, mag: 6, reload: 1.7, reserve: 36,
      life: 0.42, radius: 4, kick: 4.2, shake: 7,
    },
    railgun: {
      id: 'railgun', name: 'Right-Click', dmg: 68, cooldown: 0.95, speed: 2700,
      spread: 0.004, pellets: 1, mag: 4, reload: 1.85, reserve: 20,
      life: 1.5, radius: 6, kick: 5.5, shake: 9,
    },
  };

  const WEAPON_DROPS = ['smg', 'shotgun', 'railgun'];

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  function shortestAngle(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /*
   * The arena. Mirrored through the centre (180 deg rotational symmetry) so
   * neither spawn side has an advantage. Cover is what turns "run at each
   * other and hold fire" into something with decisions in it.
   */
  function buildMap() {
    const W = CFG.WORLD;
    const rects = [];
    const add = (x, y, w, h) => {
      rects.push({ x, y, w, h });
      // 180-degree rotation about the centre.
      rects.push({ x: W - x - w, y: W - y - h, w, h });
    };
    const c = W / 2;

    add(c - 230, c - 34, 210, 68);      // centre bars (mirrored -> a broken cross)
    add(c - 34, c - 230, 68, 210);
    add(360, 360, 250, 64);             // corner brackets
    add(360, 424, 64, 190);
    add(W / 2 - 42, 250, 84, 200);      // mid-lane pillars
    add(250, W / 2 - 42, 200, 84);
    add(760, 980, 110, 110);            // scattered blocks
    add(1180, 620, 96, 300);
    add(500, 1520, 300, 96);
    add(700, 1860, 230, 80);            // fill the outer quadrants
    add(1860, 1380, 80, 230);
    add(980, 1560, 90, 90);
    return rects;
  }

  const MAP = buildMap();

  /* Circle vs axis-aligned box. Returns a push-out vector, or null. */
  function resolveCircleRect(cx, cy, r, rect) {
    const nx = clamp(cx, rect.x, rect.x + rect.w);
    const ny = clamp(cy, rect.y, rect.y + rect.h);
    let dx = cx - nx;
    let dy = cy - ny;
    let d2 = dx * dx + dy * dy;

    if (d2 > r * r) return null;

    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      return { x: (dx / d) * (r - d), y: (dy / d) * (r - d) };
    }
    // Centre is inside the box: eject along the shallowest face.
    const left = cx - rect.x;
    const right = rect.x + rect.w - cx;
    const top = cy - rect.y;
    const bottom = rect.y + rect.h - cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: -(left + r), y: 0 };
    if (m === right) return { x: right + r, y: 0 };
    if (m === top) return { x: 0, y: -(top + r) };
    return { x: 0, y: bottom + r };
  }

  function collideWorld(p, radius) {
    for (const rect of MAP) {
      const push = resolveCircleRect(p.x, p.y, radius, rect);
      if (push) {
        p.x += push.x;
        p.y += push.y;
        // Kill the velocity component going into the wall so you slide along
        // it instead of sticking to it.
        const len = Math.hypot(push.x, push.y);
        if (len > 1e-6) {
          const nx = push.x / len;
          const ny = push.y / len;
          const into = p.vx * nx + p.vy * ny;
          if (into < 0) {
            p.vx -= nx * into;
            p.vy -= ny * into;
          }
        }
      }
    }
    p.x = clamp(p.x, radius, CFG.WORLD - radius);
    p.y = clamp(p.y, radius, CFG.WORLD - radius);
  }

  function pointInWalls(x, y, pad) {
    const m = pad || 0;
    for (const r of MAP) {
      if (x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m) return true;
    }
    return false;
  }

  /* Segment vs map, used for bot line-of-sight. */
  function segmentBlocked(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    for (const r of MAP) {
      let t0 = 0;
      let t1 = 1;
      let hit = true;
      const p = [-dx, dx, -dy, dy];
      const q = [x0 - r.x, r.x + r.w - x0, y0 - r.y, r.y + r.h - y0];
      for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-9) {
          if (q[i] < 0) { hit = false; break; }
        } else {
          const t = q[i] / p[i];
          if (p[i] < 0) { if (t > t1) { hit = false; break; } if (t > t0) t0 = t; }
          else { if (t < t0) { hit = false; break; } if (t < t1) t1 = t; }
        }
      }
      if (hit) return true;
    }
    return false;
  }

  /*
   * THE movement step. Called by the server for every command it receives and
   * by the client for every command it predicts and replays. Uses only
   * multiplication and addition (no Math.exp) so results match exactly across
   * JS engines.
   */
  function stepMovement(p, cmd, dt) {
    dt = clamp(dt, 0, CFG.MAX_CMD_DT);

    let mx = cmd.mx || 0;
    let my = cmd.my || 0;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    p.dashTime = Math.max(0, (p.dashTime || 0) - dt);
    p.dashCooldown = Math.max(0, (p.dashCooldown || 0) - dt);

    // Dash: burst along the movement stick, or along aim if standing still.
    if (cmd.dash && p.dashCooldown <= 0 && p.dashTime <= 0) {
      let dx = mx;
      let dy = my;
      if (mag < 0.15) { dx = Math.cos(cmd.aim || 0); dy = Math.sin(cmd.aim || 0); }
      const dl = Math.hypot(dx, dy) || 1;
      p.vx = (dx / dl) * CFG.DASH_SPEED;
      p.vy = (dy / dl) * CFG.DASH_SPEED;
      p.dashTime = CFG.DASH_TIME;
      p.dashCooldown = CFG.DASH_COOLDOWN;
      p.dashedAt = cmd.seq;
    }

    const dashing = p.dashTime > 0;

    if (!dashing) {
      p.vx += mx * CFG.ACCEL * dt;
      p.vy += my * CFG.ACCEL * dt;
    }

    const damp = Math.max(0, 1 - (dashing ? CFG.DASH_FRICTION : CFG.FRICTION) * dt);
    p.vx *= damp;
    p.vy *= damp;

    if (!dashing) {
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > CFG.MAX_SPEED) {
        p.vx = (p.vx / speed) * CFG.MAX_SPEED;
        p.vy = (p.vy / speed) * CFG.MAX_SPEED;
      }
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    collideWorld(p, CFG.PLAYER_RADIUS);

    if (Number.isFinite(cmd.aim)) p.aim = cmd.aim;
  }

  return {
    CFG, WEAPONS, WEAPON_DROPS, MAP,
    clamp, shortestAngle, stepMovement, collideWorld,
    pointInWalls, segmentBlocked, resolveCircleRect,
  };
});
