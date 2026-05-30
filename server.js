// Multiplayer Three.js shooter POC — server.
// - Serves the static client from /public over HTTP.
// - Runs a WebSocket server on the same port for real-time game state.
//
// Networking model (kept deliberately simple for a POC):
//   * Player movement + look + shot raycasts are client-authoritative, so the
//     shooting feels instant and responsive.
//   * Health, kills, deaths, respawns, frag scores and the "first to N wins"
//     condition are SERVER-authoritative, so all players always agree on the
//     score and on who is alive. A client only ever *reports* "I hit player X";
//     the server decides what that does.

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
// Arena + match constants  (must line up with the client)
// ---------------------------------------------------------------------------
const ARENA = 40;          // half-size of the square arena
const BOUND = 38;          // movement clamp (walls sit at ±ARENA)
const MAX_HEALTH = 100;
const FRAG_LIMIT = 10;     // first player to this many kills wins
const RESPAWN_MS = 2500;
const GAMEOVER_MS = 6000;

const COLORS = [
  "#ff5252", "#40c4ff", "#69f0ae", "#ffd740",
  "#e040fb", "#ff6e40", "#18ffff", "#b2ff59",
];
// Fixed spawn points spread around the arena.
const SPAWNS = [
  { x: 30, z: 30 }, { x: -30, z: 30 }, { x: 30, z: -30 }, { x: -30, z: -30 },
  { x: 0, z: 33 }, { x: 0, z: -33 }, { x: 33, z: 0 }, { x: -33, z: 0 },
];

let nextId = 1;
/** id -> { id, name, color, x, z, ry, rx, health, alive, frags, ws } */
const players = new Map();
let mode = "playing"; // "playing" | "gameover"
let phaseTimer = null;

function pickColor() {
  const used = new Set([...players.values()].map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[(nextId - 1) % COLORS.length];
}

function randomSpawn() {
  return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

function broadcast(obj, exceptId = null) {
  const payload = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(payload);
  }
}

function sendTo(player, obj) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(obj));
}

function respawn(player) {
  const s = randomSpawn();
  player.x = s.x; player.z = s.z;
  player.health = MAX_HEALTH;
  player.alive = true;
  broadcast({ type: "respawn", id: player.id, x: s.x, z: s.z });
}

function startGameOver(winner) {
  mode = "gameover";
  broadcast({
    type: "gameover",
    winner: winner.id,
    winnerName: winner.name,
    standings: standings(),
  });
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(newMatch, GAMEOVER_MS);
}

function newMatch() {
  mode = "playing";
  const spawns = {};
  for (const p of players.values()) {
    const s = randomSpawn();
    p.x = s.x; p.z = s.z; p.health = MAX_HEALTH; p.alive = true; p.frags = 0;
    spawns[p.id] = { x: s.x, z: s.z };
  }
  broadcast({ type: "newmatch", spawns });
}

function standings() {
  return [...players.values()]
    .map((p) => ({ id: p.id, name: p.name, frags: p.frags, color: p.color }))
    .sort((a, b) => b.frags - a.frags);
}

function applyDamage(target, dmg, killerId) {
  if (mode !== "playing" || !target.alive) return;
  target.health -= dmg;
  sendTo(target, { type: "damaged", from: killerId });

  if (target.health <= 0) {
    target.health = 0;
    target.alive = false;
    const killer = players.get(killerId);
    if (killer && killer.id !== target.id) killer.frags++;
    broadcast({
      type: "death",
      victim: target.id, victimName: target.name,
      killer: killer ? killer.id : null,
      killerName: killer ? killer.name : "the void",
    });
    if (killer && killer.id !== target.id && killer.frags >= FRAG_LIMIT) {
      startGameOver(killer);
    } else {
      setTimeout(() => { if (players.has(target.id) && mode === "playing") respawn(target); }, RESPAWN_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const id = nextId++;
  const s = randomSpawn();
  const player = {
    id, name: `Player ${id}`, color: pickColor(),
    x: s.x, z: s.z, ry: 0, rx: 0,
    health: MAX_HEALTH, alive: true, frags: 0, ws,
  };
  players.set(id, player);

  sendTo(player, {
    type: "init",
    id, color: player.color, arena: ARENA, fragLimit: FRAG_LIMIT,
    maxHealth: MAX_HEALTH, spawn: { x: s.x, z: s.z }, mode,
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "join":
        if (typeof msg.name === "string") player.name = msg.name.slice(0, 16) || player.name;
        break;

      case "input":
        // Client-authoritative position/look; clamp into arena bounds.
        if (Number.isFinite(msg.x)) player.x = Math.max(-BOUND, Math.min(BOUND, msg.x));
        if (Number.isFinite(msg.z)) player.z = Math.max(-BOUND, Math.min(BOUND, msg.z));
        if (Number.isFinite(msg.ry)) player.ry = msg.ry;
        if (Number.isFinite(msg.rx)) player.rx = msg.rx;
        break;

      case "hit": {
        // "I shot player <target> for <damage>." Validate + apply.
        const target = players.get(msg.target);
        const dmg = Math.max(0, Math.min(100, Number(msg.damage) || 0));
        if (target && player.alive && dmg > 0) applyDamage(target, dmg, id);
        break;
      }

      case "heal":
        if (player.alive && mode === "playing") {
          const amt = Math.max(0, Math.min(MAX_HEALTH, Number(msg.amount) || 0));
          player.health = Math.min(MAX_HEALTH, player.health + amt);
        }
        break;

      case "shoot":
        // Relay a shot so other clients can render a tracer + muzzle flash.
        broadcast({
          type: "shoot", id,
          ox: msg.ox, oy: msg.oy, oz: msg.oz,
          dx: msg.dx, dy: msg.dy, dz: msg.dz,
          w: msg.w,
        }, id);
        break;
    }
  });

  const drop = () => {
    if (players.delete(id)) broadcast({ type: "left", id });
  };
  ws.on("close", drop);
  ws.on("error", drop);
});

// ---------------------------------------------------------------------------
// State broadcast — 20 Hz
// ---------------------------------------------------------------------------
setInterval(() => {
  broadcast({
    type: "state",
    mode,
    players: [...players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: +p.x.toFixed(2), z: +p.z.toFixed(2),
      ry: +p.ry.toFixed(2), rx: +p.rx.toFixed(2),
      health: p.health, alive: p.alive, frags: p.frags,
    })),
  });
}, 1000 / 20);

httpServer.listen(PORT, () => {
  console.log(`\n  🔫  Multiplayer shooter POC running:  http://localhost:${PORT}\n`);
});
