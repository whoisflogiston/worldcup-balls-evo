(() => {
const CONFIG = window.CONFIG;
if (!CONFIG) {
  throw new Error("CONFIG not found. Ensure config.js is loaded before game.js.");
}

let canvas = null;
let ctx = null;
let overlay = null;
let banner = null;
let btnStart = null;
let btnRestart = null;
let statTime = null;
let statScore = null;
let statMerges = null;

const STATE = {
  BOOT: "BOOT",
  MENU: "MENU",
  PLAYING: "PLAYING",
  FINAL: "FINAL_CHALLENGE",
  SUCCESS: "SUCCESS",
  GAME_OVER: "GAME_OVER",
};

const telemetry = [];

const world = {
  baseWidth: CONFIG.world.width,
  baseHeight: CONFIG.world.height,
  width: CONFIG.world.width,
  height: CONFIG.world.height,
  gravity: CONFIG.world.gravityY * 900,
  wallRestitution: CONFIG.world.wallRestitution,
  ballRestitution: CONFIG.world.ballRestitution,
  ballFriction: CONFIG.world.ballFriction,
};

let state = STATE.BOOT;
let balls = [];
let lastTime = 0;
let startTime = null;
let score = 0;
let merges = 0;
let maxUnlockedIndex = 0;
let dangerTimer = 0;
let dangerActive = false;
let goalActive = false;
let goalHold = 0;
let goalRect = null;
let mergeEventsThisFrame = 0;
let ballIdCounter = 1;
let viewScale = 1;
let spawnLineY = 0;
let ballScale = 1;
let nextSpawnTimeout = null;

function getDangerY() {
  return world.height * CONFIG.danger.dangerYRatio;
}

const pointer = {
  active: false,
  x: 0,
  y: 0,
  startX: 0,
  startY: 0,
  prevX: 0,
  prevY: 0,
  prevMoveTime: 0,
  lastX: 0,
  lastY: 0,
  startTime: 0,
  lastMoveTime: 0,
  grabbedBall: null,
  grabStart: 0,
  moved: false,
};

const spriteMap = new Map();
let mergeFx = [];

function logEvent(type, data = {}) {
  telemetry.push({ type, data, time: performance.now() });
  console.log("[telemetry]", type, data);
}

function setOverlay(html) {
  if (!overlay) return;
  overlay.innerHTML = html;
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  if (!overlay) return;
  overlay.classList.add("hidden");
}

function setBanner(text) {
  if (!banner) return;
  banner.textContent = text;
  banner.classList.add("show");
  clearTimeout(banner._t);
  banner._t = setTimeout(() => banner.classList.remove("show"), 2200);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const prevWidth = world.width;
  const prevHeight = world.height;
  world.width = rect.width;
  world.height = rect.height;
  viewScale = world.width / world.baseWidth;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ballScale = rect.width <= 720 ? 4 : 2;
  const sizeScale = world.width / world.baseWidth;
  spawnLineY = Math.max(20, (maxBaseRadius() * sizeScale * ballScale) + CONFIG.spawn.spawnLineOffset);
  world.gravity = CONFIG.world.gravityY * 900 * (world.height / world.baseHeight);

  if (prevWidth && prevHeight) {
    const sx = world.width / prevWidth;
    const sy = world.height / prevHeight;
    for (const ball of balls) {
      ball.x *= sx;
      ball.y *= sy;
      ball.vx *= sx;
      ball.vy *= sy;
      ball.radius = ball.baseRadius * sizeScale * ballScale;
    }
  }

  prepareSprites();
}

function maxBaseRadius() {
  return Math.max(...CONFIG.tiers.map((t) => t.radius));
}

function prepareSprites() {
  CONFIG.tiers.forEach((tier) => {
    if (spriteMap.has(tier.id)) return;
    const img = new Image();
    img.src = encodeURI(tier.sprite);
    spriteMap.set(tier.id, img);
  });
}

function resetGame() {
  balls = [];
  lastTime = performance.now();
  startTime = null;
  score = 0;
  merges = 0;
  maxUnlockedIndex = 0;
  dangerTimer = 0;
  dangerActive = false;
  goalActive = false;
  goalHold = 0;
  goalRect = null;
  mergeEventsThisFrame = 0;
  ballIdCounter = 1;
  mergeFx = [];
  if (nextSpawnTimeout) {
    clearTimeout(nextSpawnTimeout);
    nextSpawnTimeout = null;
  }
  logEvent("game_start");
}

function startGame() {
  resetGame();
  startTime = performance.now();
  state = STATE.PLAYING;
  hideOverlay();
  setBanner("Старт!");
  spawnHeldBall();
}

function endGame(reason) {
  state = STATE.GAME_OVER;
  setOverlay(`<div>Игра окончена<br><small>Причина: ${reason}</small><br><br><strong>Очки:</strong> ${score}</div>`);
  logEvent("game_over", { reason, timeSec: elapsedSeconds(), score });
}

function successGame() {
  state = STATE.SUCCESS;
  setOverlay(`<div>Победа!<br><small>Вы закатили мяч 2026 в ворота</small><br><br><strong>Время:</strong> ${formatTime(elapsedSeconds())}<br><strong>Слияний:</strong> ${merges}<br><strong>Очки:</strong> ${score}<br><br><button id="bonus" class="primary">Забрать бонус</button></div>`);
  logEvent("final_success", { timeSec: elapsedSeconds(), score });
  const bonusBtn = document.getElementById("bonus");
  if (bonusBtn) {
    bonusBtn.addEventListener("click", () => {
      logEvent("bonus_click");
      setBanner("Бонус получен!");
    });
  }
}

function elapsedSeconds() {
  if (!startTime) return 0;
  return (performance.now() - startTime) / 1000;
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function selectTierIndex() {
  const maxIndex = maxUnlockedIndex;
  return Math.floor(Math.random() * (maxIndex + 1));
}

function createBall(tierIndex, position, velocity = { x: 0, y: 0 }) {
  const tier = CONFIG.tiers[tierIndex];
  const sizeScale = (world.width / world.baseWidth) * ballScale;
  const ball = {
    id: ballIdCounter++,
    tierIndex,
    tierId: tier.id,
    baseRadius: tier.radius,
    radius: tier.radius * sizeScale,
    x: position.x,
    y: position.y,
    vx: velocity.x,
    vy: velocity.y,
    lockedForMergeUntil: 0,
    createdAt: performance.now(),
    isHeld: false,
    pulseStart: 0,
    pulseEnd: 0,
  };
  balls.push(ball);
  logEvent("spawn_ball", { tierId: tier.id });
  return ball;
}

function canPlaceAt(x, y, radius) {
  for (const ball of balls) {
    const dx = ball.x - x;
    const dy = ball.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < ball.radius + radius + 4) {
      return false;
    }
  }
  return true;
}

function spawnHeldBall() {
  if (state !== STATE.PLAYING && state !== STATE.FINAL) return;
  if (balls.some((b) => b.isHeld)) return;
  const tierIndex = selectTierIndex();
  const tier = CONFIG.tiers[tierIndex];
  const tierRadius = tier.radius * (world.width / world.baseWidth) * ballScale;
  const margin = tierRadius + 8;
  let x = margin + Math.random() * (world.width - margin * 2);
  let y = spawnLineY;
  let placed = canPlaceAt(x, y, tierRadius);
  for (let i = 0; i < CONFIG.spawn.maxAttempts && !placed; i += 1) {
    x += (Math.random() - 0.5) * 80;
    x = Math.max(margin, Math.min(world.width - margin, x));
    placed = canPlaceAt(x, y, tierRadius);
  }
  const ball = createBall(tierIndex, { x, y }, { x: 0, y: 0 });
  ball.isHeld = true;
  ball.vx = 0;
  ball.vy = 0;
}

function applyForces(dt) {
  for (const ball of balls) {
    if (!ball.isHeld) {
      ball.vy += world.gravity * dt;
    } else {
      ball.vx = 0;
      ball.vy = 0;
    }
    ball.vx *= 1 - Math.min(1, world.ballFriction * dt);
    ball.vy *= 1 - Math.min(1, world.ballFriction * dt);
  }
}

function integrate(dt) {
  for (const ball of balls) {
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
  }
}

function resolveWall(ball) {
  if (ball.isHeld) return;
  const r = ball.radius;
  if (ball.x - r < 0) {
    ball.x = r;
    ball.vx = Math.abs(ball.vx) * world.wallRestitution;
  } else if (ball.x + r > world.width) {
    ball.x = world.width - r;
    ball.vx = -Math.abs(ball.vx) * world.wallRestitution;
  }
  if (ball.y - r < 0) {
    ball.y = r;
    ball.vy = Math.abs(ball.vy) * world.wallRestitution;
  } else if (ball.y + r > world.height) {
    ball.y = world.height - r;
    ball.vy = -Math.abs(ball.vy) * world.wallRestitution;
  }
}

function resolveBallCollision(a, b, now) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = a.radius + b.radius;
  if (dist === 0 || dist >= minDist) {
    return false;
  }
  if (a.tierIndex === b.tierIndex && mergeEligible(a, now) && mergeEligible(b, now)) {
    return true;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  const penetration = minDist - dist;
  const separation = penetration / 2;
  a.x -= nx * separation;
  a.y -= ny * separation;
  b.x += nx * separation;
  b.y += ny * separation;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  if (velAlongNormal > 0) return true;

  const restitution = world.ballRestitution;
  const impulse = -(1 + restitution) * velAlongNormal / 2;
  const ix = impulse * nx;
  const iy = impulse * ny;

  a.vx -= ix;
  a.vy -= iy;
  b.vx += ix;
  b.vy += iy;

  return true;
}

function buildContactGraph(tierIndex) {
  const nodes = balls.filter((b) => b.tierIndex === tierIndex && !b.isHeld);
  const adjacency = new Map();
  for (const ball of nodes) adjacency.set(ball.id, new Set());

  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= a.radius + b.radius + 1.5) {
        adjacency.get(a.id).add(b.id);
        adjacency.get(b.id).add(a.id);
      }
    }
  }

  return { nodes, adjacency };
}

function findComponents(nodes, adjacency) {
  const visited = new Set();
  const components = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const componentIds = [];
    visited.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      componentIds.push(id);
      const neighbors = adjacency.get(id) || [];
      for (const nId of neighbors) {
        if (!visited.has(nId)) {
          visited.add(nId);
          stack.push(nId);
        }
      }
    }
    components.push(componentIds);
  }
  return components;
}

function mergeEligible(ball, now) {
  return now > ball.lockedForMergeUntil && now - ball.createdAt > CONFIG.merge.newBallDelayMs;
}

function performMerges(now) {
  mergeEventsThisFrame = 0;
  for (let tierIndex = 0; tierIndex < CONFIG.tiers.length - 1; tierIndex += 1) {
    if (mergeEventsThisFrame >= CONFIG.merge.maxMergesPerFrame) return;
    const mergeN = CONFIG.mergeRules[CONFIG.tiers[tierIndex].id] || 2;
    if (mergeN < 2) continue;
    const { nodes, adjacency } = buildContactGraph(tierIndex);
    if (!nodes.length) continue;
    const components = findComponents(nodes, adjacency);

    for (const compIds of components) {
      if (mergeEventsThisFrame >= CONFIG.merge.maxMergesPerFrame) return;
      if (compIds.length < mergeN) continue;

      const compBalls = compIds
        .map((id) => balls.find((b) => b.id === id))
        .filter(Boolean)
        .filter((b) => mergeEligible(b, now));

      if (compBalls.length < mergeN) continue;

      const cx = compBalls.reduce((sum, b) => sum + b.x, 0) / compBalls.length;
      const cy = compBalls.reduce((sum, b) => sum + b.y, 0) / compBalls.length;

      const sorted = compBalls
        .slice()
        .sort((a, b) => {
          const da = Math.hypot(a.x - cx, a.y - cy);
          const db = Math.hypot(b.x - cx, b.y - cy);
          if (da !== db) return da - db;
          const sa = Math.hypot(a.vx, a.vy);
          const sb = Math.hypot(b.vx, b.vy);
          return sa - sb;
        });

      const selected = sorted.slice(0, mergeN);
      if (selected.length < mergeN) continue;

      const avgX = selected.reduce((sum, b) => sum + b.x, 0) / selected.length;
      const avgY = selected.reduce((sum, b) => sum + b.y, 0) / selected.length;
      const avgVx = selected.reduce((sum, b) => sum + b.vx, 0) / selected.length;
      const avgVy = selected.reduce((sum, b) => sum + b.vy, 0) / selected.length;

      for (const ball of selected) {
        ball.lockedForMergeUntil = now + CONFIG.merge.cooldownMs;
      }

      balls = balls.filter((b) => !selected.includes(b));

      const nextIndex = tierIndex + 1;
      const newBall = createBall(nextIndex, { x: avgX, y: avgY }, {
        x: avgVx * CONFIG.merge.velocityScale,
        y: avgVy * CONFIG.merge.velocityScale + CONFIG.merge.popY * 100,
      });
      newBall.pulseStart = now;
      newBall.pulseEnd = now + CONFIG.merge.pulseMs;
      mergeFx.push({
        x: avgX,
        y: avgY,
        start: now,
        end: now + CONFIG.merge.pulseMs,
      });

      logEvent("merge", {
        fromTier: CONFIG.tiers[tierIndex].id,
        toTier: CONFIG.tiers[nextIndex].id,
      });

      merges += 1;
      if (CONFIG.scoring.enabled) {
        score += CONFIG.scoring.base * Math.pow(nextIndex + 1, 2);
      }

      if (nextIndex > maxUnlockedIndex) {
        maxUnlockedIndex = nextIndex;
        logEvent("unlock_tier", { tierId: CONFIG.tiers[nextIndex].id });
        setBanner(`Открыт ${CONFIG.tiers[nextIndex].name}`);
      }

      if (nextIndex === CONFIG.tiers.length - 1) {
        enterFinalChallenge(newBall);
      }

      mergeEventsThisFrame += 1;
    }
  }
}

function enterFinalChallenge(ball) {
  if (goalActive) return;
  goalActive = true;
  state = STATE.FINAL;
  goalRect = {
    width: 200,
    height: 60,
    x: world.width / 2 - 100,
    y: world.height - 80,
  };
  setBanner("Финал: закати мяч 2026 в ворота!");
  logEvent("final_start");
  ball.lockedForMergeUntil = Infinity;
}

function checkGoal(dt) {
  if (!goalActive || state !== STATE.FINAL) return;
  const finalTierIndex = CONFIG.tiers.length - 1;
  const ball = balls.find((b) => b.tierIndex === finalTierIndex);
  if (!ball) return;

  const rx = goalRect.x;
  const ry = goalRect.y;
  const rw = goalRect.width;
  const rh = goalRect.height;

  const closestX = Math.max(rx, Math.min(ball.x, rx + rw));
  const closestY = Math.max(ry, Math.min(ball.y, ry + rh));
  const dx = ball.x - closestX;
  const dy = ball.y - closestY;
  const inGoal = dx * dx + dy * dy <= ball.radius * ball.radius;

  if (inGoal) {
    goalHold += dt * 1000;
    if (goalHold >= CONFIG.goal.holdMs) {
      successGame();
    }
  } else {
    goalHold = 0;
  }
}

function updateDanger(dt) {
  const dangerY = getDangerY();
  const count = balls.filter((b) => !b.isHeld && b.y <= dangerY).length;
  if (count >= CONFIG.danger.countLimit) {
    if (!dangerActive) {
      dangerActive = true;
      logEvent("danger_enter");
    }
    dangerTimer += dt;
    if (dangerTimer >= CONFIG.danger.holdSec) {
      endGame("Перегруз зоны опасности");
    }
  } else {
    if (dangerActive) {
      dangerActive = false;
      logEvent("danger_exit");
    }
    dangerTimer = 0;
  }
}

function updateHUD() {
  if (!statTime || !statScore || !statMerges) return;
  statTime.textContent = formatTime(elapsedSeconds());
  statScore.textContent = Math.floor(score);
  statMerges.textContent = merges;
}

function step(now) {
  const dtRaw = (now - lastTime) / 1000;
  const dt = Math.min(0.033, Math.max(0.001, dtRaw));
  lastTime = now;
  if (state === STATE.PLAYING || state === STATE.FINAL) {
    applyForces(dt);
    applyGrabForce(dt);
    integrate(dt);
    for (const ball of balls) resolveWall(ball);
    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const a = balls[i];
        const b = balls[j];
        if (a.isHeld || b.isHeld) continue;
        resolveBallCollision(a, b, now);
      }
    }
    performMerges(now);
    updateDanger(dt);
    checkGoal(dt);
  }
  updateHUD();
  render();
  requestAnimationFrame(step);
}

function render() {
  if (!ctx) return;
  const now = performance.now();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  const dangerY = getDangerY();
  const fieldCenterX = world.width * 0.5;
  const fieldCenterY = world.height * 0.5;
  const centerCircleRadius = Math.min(world.width, world.height) * 0.2;

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.36)";
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(fieldCenterX, fieldCenterY, centerCircleRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = dangerActive ? "rgba(255, 77, 77, 0.95)" : "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = dangerActive ? 7 : 6;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, dangerY);
  ctx.lineTo(world.width, dangerY);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(0, spawnLineY);
  ctx.lineTo(world.width, spawnLineY);
  ctx.stroke();
  if (dangerActive) {
    const remaining = Math.max(0, CONFIG.danger.holdSec - dangerTimer);
    ctx.fillStyle = "rgba(255, 77, 77, 0.9)";
    ctx.font = "bold 16px 'Alegreya Sans', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(remaining.toFixed(1), world.width - 16, dangerY - 10);
  }
  ctx.restore();

  if (goalActive && goalRect) {
    ctx.save();
    ctx.strokeStyle = "rgba(98, 227, 255, 0.9)";
    ctx.lineWidth = 3;
    ctx.strokeRect(goalRect.x, goalRect.y, goalRect.width, goalRect.height);
    ctx.fillStyle = "rgba(98, 227, 255, 0.12)";
    ctx.fillRect(goalRect.x, goalRect.y, goalRect.width, goalRect.height);
    ctx.restore();
  }

  mergeFx = mergeFx.filter((fx) => fx.end > now);
  for (const fx of mergeFx) {
    const p = Math.max(0, Math.min(1, (now - fx.start) / (fx.end - fx.start)));
    const alpha = (1 - p) * 0.55;
    const radius = 10 + p * 42;
    ctx.save();
    ctx.strokeStyle = `rgba(255, 232, 140, ${alpha})`;
    ctx.lineWidth = 5 - p * 3.2;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  for (const ball of balls) {
    const sprite = spriteMap.get(ball.tierId);
    const pulseDuration = Math.max(1, ball.pulseEnd - ball.pulseStart);
    const pulseT = Math.max(0, Math.min(1, (now - ball.pulseStart) / pulseDuration));
    const pulseActive = now < ball.pulseEnd;
    let sx = 1;
    let sy = 1;
    if (pulseActive) {
      if (pulseT < 0.45) {
        const u = pulseT / 0.45;
        sx = 1 + u * CONFIG.merge.jellyStrength;
        sy = 1 - u * CONFIG.merge.jellyStrength * 0.7;
      } else {
        const u = (pulseT - 0.45) / 0.55;
        sx = 1 + (1 - u) * CONFIG.merge.jellyStrength * 0.35;
        sy = 1 - (1 - u) * CONFIG.merge.jellyStrength * 0.2;
      }
    }

    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      const w = ball.radius * 2;
      const h = ball.radius * 2;
      ctx.save();
      ctx.translate(ball.x, ball.y);
      ctx.scale(sx, sy);
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = "#fff";
      ctx.save();
      ctx.translate(ball.x, ball.y);
      ctx.scale(sx, sy);
      ctx.beginPath();
      ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function applyGrabForce(dt) {
  if (!pointer.grabbedBall) return;
  const ball = pointer.grabbedBall;
  if (ball.isHeld) {
    const r = ball.radius;
    ball.x = Math.max(r, Math.min(world.width - r, pointer.x));
    ball.y = spawnLineY;
    ball.vx = 0;
    ball.vy = 0;
    return;
  }
  const now = performance.now();
  if (now - pointer.grabStart > CONFIG.grab.maxGrabTimeSec * 1000) {
    ball.vy += 180;
    pointer.grabbedBall = null;
    return;
  }
  const dx = pointer.x - ball.x;
  const dy = pointer.y - ball.y;
  ball.vx += dx * CONFIG.grab.dragForce * dt;
  ball.vy += dy * CONFIG.grab.dragForce * dt;
}

function getPointerPos(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function findBallAt(x, y) {
  for (let i = balls.length - 1; i >= 0; i -= 1) {
    const ball = balls[i];
    const dist = Math.hypot(ball.x - x, ball.y - y);
    if (dist <= ball.radius + 2) return ball;
  }
  return null;
}

function onPointerDown(event) {
  event.preventDefault();
  if (state !== STATE.PLAYING && state !== STATE.FINAL) return;
  pointer.active = true;
  const pos = getPointerPos(event);
  pointer.x = pos.x;
  pointer.y = pos.y;
  pointer.startX = pos.x;
  pointer.startY = pos.y;
  pointer.prevX = pos.x;
  pointer.prevY = pos.y;
  pointer.lastX = pos.x;
  pointer.lastY = pos.y;
  pointer.startTime = performance.now();
  pointer.prevMoveTime = pointer.startTime;
  pointer.lastMoveTime = pointer.startTime;
  pointer.moved = false;
  const ball = findBallAt(pos.x, pos.y);
  const dangerY = getDangerY();
  if (ball && (ball.isHeld || ball.y <= dangerY)) {
    pointer.grabbedBall = ball;
    pointer.grabStart = performance.now();
  }
}

function onPointerMove(event) {
  event.preventDefault();
  if (!pointer.active) return;
  const pos = getPointerPos(event);
  const now = performance.now();
  pointer.prevX = pointer.lastX;
  pointer.prevY = pointer.lastY;
  pointer.prevMoveTime = pointer.lastMoveTime;
  pointer.x = pos.x;
  pointer.y = pos.y;
  pointer.lastX = pos.x;
  pointer.lastY = pos.y;
  pointer.lastMoveTime = now;
  const moved = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > 8;
  if (moved) pointer.moved = true;
}

function onPointerUp(event) {
  event.preventDefault();
  if (!pointer.active) return;
  const pos = getPointerPos(event);
  const elapsed = performance.now() - pointer.startTime;
  if (pointer.grabbedBall && pointer.grabbedBall.isHeld) {
    const ball = pointer.grabbedBall;
    ball.isHeld = false;
    const sinceLastMoveMs = performance.now() - pointer.lastMoveTime;
    const segmentDtMs = Math.max(1, pointer.lastMoveTime - pointer.prevMoveTime);
    const segmentDx = pointer.lastX - pointer.prevX;
    if (sinceLastMoveMs <= 90 && Math.abs(segmentDx) >= 1.5) {
      const vxRecent = (segmentDx / segmentDtMs) * 1000;
      ball.vx = Math.max(-450, Math.min(450, vxRecent));
    } else {
      ball.vx = 0;
    }
    ball.vy = 0;
    if (nextSpawnTimeout) clearTimeout(nextSpawnTimeout);
    nextSpawnTimeout = setTimeout(() => {
      spawnHeldBall();
    }, 180);
    pointer.active = false;
    pointer.grabbedBall = null;
    return;
  }
  if (!pointer.moved && elapsed < 200) {
    const ball = findBallAt(pos.x, pos.y);
    if (ball) {
      const dx = pos.x - ball.x;
      const dy = pos.y - ball.y;
      const dist = Math.hypot(dx, dy) || 1;
      ball.vx += (dx / dist) * CONFIG.grab.tapImpulse;
      ball.vy += (dy / dist) * CONFIG.grab.tapImpulse;
    }
  }
  pointer.active = false;
  pointer.grabbedBall = null;
}

window.addEventListener("resize", resizeCanvas);

function bindElements() {
  canvas = document.getElementById("game");
  overlay = document.getElementById("overlay");
  banner = document.getElementById("banner");
  btnStart = document.getElementById("btn-start");
  btnRestart = document.getElementById("btn-restart");
  statTime = document.getElementById("stat-time");
  statScore = document.getElementById("stat-score");
  statMerges = document.getElementById("stat-merges");
  ctx = canvas ? canvas.getContext("2d") : null;

  if (btnStart) btnStart.addEventListener("click", startGame);
  if (btnRestart) btnRestart.addEventListener("click", startGame);

  if (canvas) {
    canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
    canvas.addEventListener("pointermove", onPointerMove, { passive: false });
    canvas.addEventListener("pointerup", onPointerUp, { passive: false });
    canvas.addEventListener("pointerleave", onPointerUp, { passive: false });
  }
}

function boot() {
  if (!CONFIG) {
    setOverlay("CONFIG не загружен. Проверьте, что config.js доступен.");
    return;
  }
  bindElements();
  if (!canvas || !ctx) {
    setOverlay("Canvas недоступен в этом браузере.");
    return;
  }
  resizeCanvas();
  prepareSprites();
  state = STATE.MENU;
  setOverlay("Нажмите&nbsp;<strong>Старт</strong>&nbsp;для&nbsp;начала&nbsp;игры");
  requestAnimationFrame((t) => {
    lastTime = t;
    requestAnimationFrame(step);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
})();
