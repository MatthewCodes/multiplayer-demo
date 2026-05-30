# 🔫 Three.js Multiplayer Arena Shooter — Proof of Concept

A real-time multiplayer first-person shooter. Join an arena, run around with
**WASD**, aim with the **mouse**, and frag other players. It's a free-for-all
deathmatch — **first to 10 kills wins**, then the match auto-restarts.

Built by combining a single-player Three.js shooter (`public/shooter.html`, kept
as a reference) with a WebSocket multiplayer layer.

## Controls

| Action | Key |
|--------|-----|
| Move | `W` `A` `S` `D` (or arrows) |
| Aim | Mouse (pointer lock) |
| Shoot | Left click or `Space` |
| Switch weapon | `Q` |
| Free the cursor | `Esc` (click to re-lock) |

Grab the glowing **orange box** for a machine gun, **yellow** for ammo, **green**
for health.

## Networking model

```
 Browser (client)                    Node.js server
 ----------------                    --------------
 Three.js FPS scene      <—WebSocket—>   ws server
 - WASD + mouse move YOU              - relays everyone's position/aim
 - your shots raycast locally         - validates hits ("A shot B")
 - reports "I hit player X"           - owns health, deaths, respawns
 - renders other players + tracers    - tracks frags, "first to 10", restart
```

- **Client-authoritative**: your movement, aim, and shot raycasts — so shooting
  feels instant.
- **Server-authoritative**: health, who-killed-who, deaths, respawns, frag
  scores, and the win condition — so everyone always agrees on the score.

The arena layout (walls, cover, pillars) is **fixed/deterministic**, so every
player sees identical cover.

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows (or two devices), enter names,
and frag each other. Each shot's hit detection runs on the shooter's client and
is confirmed by the server.

## Play with a friend in another state (free hosting)

### Render (free, supports WebSockets)

1. Push this repo to GitHub.
2. render.com → **New +** → **Blueprint** → select the repo. It reads
   `render.yaml` and deploys on the **free** plan.
3. Share the `https://your-app.onrender.com` URL — you both open it and play.

> Free instances sleep after ~15 min idle; the first load after that takes
> ~30–60 s to wake. For an instant throwaway test: `npm start` +
> `npx ngrok http 3000`.

## Project layout

| File | Purpose |
|------|---------|
| `server.js` | HTTP static server + WebSocket game server (health, kills, respawns, scoring) |
| `public/index.html` | Multiplayer FPS client (scene, FPS controls, shooting, networking, HUD) |
| `public/shooter.html` | Original single-player shooter (kept as a reference) |
| `package.json` | Node project + `ws` dependency |
| `render.yaml` | One-click Render deployment config (free tier) |

## Tuning knobs

In `server.js`:
- `ARENA` / `BOUND` — arena size + movement clamp
- `FRAG_LIMIT` — kills to win (default 10)
- `RESPAWN_MS`, `GAMEOVER_MS` — respawn delay / post-match pause
- `MAX_HEALTH`, `SPAWNS`, `COLORS`

In `public/index.html`:
- `player.speed`, weapon `damage`/`cooldown` in `shoot()`
- the fixed `obstacles` array (arena cover) and pickup positions
- mouse sensitivity (`movementX/Y * 0.002`)
