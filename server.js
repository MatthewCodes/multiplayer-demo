// Multiplayer Three.js soccer POC — server.
// - Serves the static client from /public over HTTP.
// - Runs a WebSocket server on the same port for real-time game state.
//
// Networking model (kept deliberately simple for a POC):
//   * Player movement is client-authoritative: each client tells the server
//     where it is; the server clamps it to the pitch and relays to everyone.
//   * EVERYTHING ELSE is server-authoritative: ball physics, goal detection,
//     scoring, spawn resets, and the "first to 5 wins" condition. That way all
//     players always agree on the score and the ball.
//
// Teams: odd player IDs join Team 1, even IDs join Team 2.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const httpServer = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = normalize(join(PUBLIC_DIR, urlPath));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ---------------------------------------------------------------------------
// Pitch + game constants
// ---------------------------------------------------------------------------
const ARENA_X = 15;        // half-width of the pitch (sidelines at ±X)
const ARENA_Z = 22;        // half-length of the pitch (goal lines at ±Z)
const GOAL_HALF = 5;       // half-width of the goal mouth
const PLAYER_RADIUS = 0.6;
const BALL_RADIUS = 0.8;
const WIN_SCORE = 5;

const CELEBRATE_MS = 2500; // pause after a goal
const GAMEOVER_MS = 7000;  // pause after a match is won, then auto-restart

const TEAM_COLORS = { 1: "#ff5252", 2: "#40c4ff" };
// Where each team lines up. Team 1 defends -Z, Team 2 defends +Z.
const SPAWN_OFFSETS = [0, 4, -4, 8, -8, 12, -12, 6, -6, 10, -10];

let nextId = 1;
/** id -> { id, team, name, color, x, z, ry, spawnX, spawnZ, ws } */
const players = new Map();
const teamCounts = { 1: 0, 2: 0 };

const ball = { x: 0, z: 0, vx: 0, vz: 0 };
const scores = { 1: 0, 2: 0 };
let mode = "playing"; // "playing" | "celebrating" | "gameover"
let phaseTimer = null;

function spawnFor(team, indexInTeam) {
  const baseZ = team === 1 ? -ARENA_Z * 0.55 : ARENA_Z * 0.55;
  const x = SPAWN_OFFSETS[indexInTeam % SPAWN_OFFSETS.length] ?? 0;
  return { x, z: baseZ };
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.send(payload);
  }
}

function spawnPayload() {
  const spawns = {};
  for (const p of players.values()) spawns[p.id] = { x: p.spawnX, z: p.spawnZ };
  return { spawns, ball: { x: 0, z: 0 } };
}

function resetField() {
  ball.x = 0; ball.z = 0; ball.vx = 0; ball.vz = 0;
  for (const p of players.values()) {
    p.x = p.spawnX; p.z = p.spawnZ;
    p.ry = p.team === 1 ? 0 : Math.PI; // face the opponent's end
  }
}

function newGame() {
  scores[1] = 0; scores[2] = 0;
  resetField();
  mode = "playing";
  broadcast({ type: "newgame", scores: { ...scores }, ...spawnPayload() });
}

function onGoal(scoringTeam) {
  scores[scoringTeam]++;
  resetField(); // freezes ball at center + sends players home
  broadcast({ type: "goal", team: scoringTeam, scores: { ...scores }, ...spawnPayload() });

  clearTimeout(phaseTimer);
  if (scores[scoringTeam] >= WIN_SCORE) {
    mode = "gameover";
    broadcast({ type: "gameover", winner: scoringTeam, scores: { ...scores } });
    phaseTimer = setTimeout(newGame, GAMEOVER_MS);
  } else {
    mode = "celebrating";
    phaseTimer = setTimeout(() => { mode = "playing"; }, CELEBRATE_MS);
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const id = nextId++;
  const team = id % 2 === 1 ? 1 : 2;     // odd -> Team 1, even -> Team 2
  const idx = teamCounts[team]++;
  const spawn = spawnFor(team, idx);
  const player = {
    id, team, name: `Player ${id}`, color: TEAM_COLORS[team],
    x: spawn.x, z: spawn.z, ry: team === 1 ? 0 : Math.PI,
    spawnX: spawn.x, spawnZ: spawn.z, ws,
  };
  players.set(id, player);

  ws.send(JSON.stringify({
    type: "init",
    id, team, color: player.color,
    arenaX: ARENA_X, arenaZ: ARENA_Z, goalHalf: GOAL_HALF,
    winScore: WIN_SCORE,
    scores: { ...scores }, mode,
    spawn: { x: spawn.x, z: spawn.z },
  }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join" && typeof msg.name === "string") {
      player.name = msg.name.slice(0, 16) || player.name;
    } else if (msg.type === "input" && mode === "playing") {
      // Trust + clamp the client's position into the pitch bounds.
      if (Number.isFinite(msg.x)) player.x = Math.max(-ARENA_X, Math.min(ARENA_X, msg.x));
      if (Number.isFinite(msg.z)) player.z = Math.max(-ARENA_Z, Math.min(ARENA_Z, msg.z));
      if (Number.isFinite(msg.ry)) player.ry = msg.ry;
    }
  });

  const drop = () => {
    if (players.delete(id)) teamCounts[team] = Math.max(0, teamCounts[team] - 1);
  };
  ws.on("close", drop);
  ws.on("error", drop);
});

// ---------------------------------------------------------------------------
// Server-authoritative physics tick (ball + goals) — 30 Hz
// ---------------------------------------------------------------------------
const TICK_HZ = 30;
const dt = 1 / TICK_HZ;
const FRICTION = 0.98;     // ball rolls a while before stopping
const PUSH_SPEED = 16;     // how hard a player "kicks" the ball

setInterval(() => {
  if (mode !== "playing") return; // ball is frozen during celebration / game over

  // Integrate ball motion + friction.
  ball.vx *= FRICTION;
  ball.vz *= FRICTION;
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;

  // Sidelines (±X) always bounce.
  const limitX = ARENA_X - BALL_RADIUS;
  if (ball.x < -limitX) { ball.x = -limitX; ball.vx = Math.abs(ball.vx); }
  if (ball.x > limitX) { ball.x = limitX; ball.vx = -Math.abs(ball.vx); }

  const limitZ = ARENA_Z - BALL_RADIUS;
  // +Z end is Team 2's goal -> Team 1 scores there.
  if (ball.z > ARENA_Z && Math.abs(ball.x) < GOAL_HALF) return onGoal(1);
  if (ball.z > limitZ && Math.abs(ball.x) >= GOAL_HALF) { ball.z = limitZ; ball.vz = -Math.abs(ball.vz); }
  // -Z end is Team 1's goal -> Team 2 scores there.
  if (ball.z < -ARENA_Z && Math.abs(ball.x) < GOAL_HALF) return onGoal(2);
  if (ball.z < -limitZ && Math.abs(ball.x) >= GOAL_HALF) { ball.z = -limitZ; ball.vz = Math.abs(ball.vz); }

  // Resolve player kicks: if a player overlaps the ball, shove it away.
  const minDist = PLAYER_RADIUS + BALL_RADIUS;
  for (const p of players.values()) {
    const dx = ball.x - p.x;
    const dz = ball.z - p.z;
    const dist = Math.hypot(dx, dz) || 0.0001;
    if (dist < minDist) {
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      ball.x += nx * overlap;
      ball.z += nz * overlap;
      ball.vx = nx * PUSH_SPEED;
      ball.vz = nz * PUSH_SPEED;
    }
  }
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------------------
// State broadcast — 20 Hz
// ---------------------------------------------------------------------------
setInterval(() => {
  broadcast({
    type: "state",
    mode,
    scores: { ...scores },
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, color: p.color,
      x: +p.x.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2),
    })),
    ball: { x: +ball.x.toFixed(2), z: +ball.z.toFixed(2) },
  });
}, 1000 / 20);

httpServer.listen(PORT, () => {
  console.log(`\n  ⚽  Multiplayer soccer POC running:  http://localhost:${PORT}\n`);
});
