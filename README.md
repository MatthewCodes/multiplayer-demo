# ⚽ Three.js Multiplayer Soccer — Proof of Concept

A tiny real-time multiplayer soccer game. Each player joins a shared pitch as a
colored avatar, walks with **WASD**, and rams a shared ball into the other
team's goal. Score a goal → confetti flies, the scoreboard updates, everyone
resets to their spawn, and a fresh ball drops in the center. **First to 5 wins**,
then the match auto-restarts.

- **Teams** are assigned automatically: odd-numbered players join **Team 1 (Red)**,
  even-numbered players join **Team 2 (Blue)**.
- **Player movement** is client-authoritative (low latency, feels responsive).
- **Everything else** — ball physics, goal detection, scoring, spawn resets, and
  the win condition — is **server-authoritative**, so all players always agree
  on the ball and the score.

## How it works

```
 Browser (client)                    Node.js server
 ----------------                    --------------
 Three.js scene          <—WebSocket—>   ws server
 - renders pitch, goals, avatars      - assigns teams (odd=1, even=2)
 - WASD moves YOU locally             - runs ball physics (authoritative)
 - sends your position 20x/sec        - detects goals, keeps score
 - shows scoreboard + confetti        - resets spawns, "first to 5" + restart
                                       - broadcasts game state 20x/sec
```

## Run it locally

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser tabs (or two devices on your network),
pick names, and you'll be put on opposite teams. Walk into the ball to kick it
toward the other team's goal.

## Play with a friend in another state (free hosting)

### Option A — Render (recommended, free, supports WebSockets)

1. Put this folder in a GitHub repo and push it.
2. Go to https://render.com → sign up → **New +** → **Blueprint**.
3. Select your repo. Render reads `render.yaml` and deploys on the **free** plan.
4. You get a public URL like `https://your-app.onrender.com`. Share it — you both
   open it and play. WebSockets upgrade automatically over `https` (`wss://`).

> Free services sleep after ~15 min idle, so the first visit after a quiet
> period takes ~30–60s to wake up. Normal for the free tier.

### Option B — Fly.io (free allowance, also supports WebSockets)

```bash
# install flyctl first: https://fly.io/docs/flyctl/install/
fly launch        # accept Node defaults, pick a region
fly deploy
```

### Option C — ngrok tunnel (fastest test, only while your PC is on)

```bash
npm start                      # terminal 1
npx ngrok http 3000            # terminal 2 → gives a public https URL
```

Share the ngrok URL with your friend.

## Project layout

| File | Purpose |
|------|---------|
| `server.js` | HTTP static server + WebSocket game server + ball physics + scoring |
| `public/index.html` | Three.js client (pitch, goals, avatars, input, networking, scoreboard, confetti) |
| `package.json` | Node project + `ws` dependency |
| `render.yaml` | One-click Render deployment config (free tier) |

## Tuning knobs

In `server.js`:
- `ARENA_X`, `ARENA_Z` — pitch half-width / half-length
- `GOAL_HALF` — goal mouth size
- `WIN_SCORE` — goals needed to win (default 5)
- `PUSH_SPEED` — how hard players kick the ball
- `FRICTION` — how long the ball rolls
- `CELEBRATE_MS`, `GAMEOVER_MS` — pause lengths after a goal / after a win

In `public/index.html`:
- `SPEED` — player move speed
- camera offset, interpolation factors
- Pitch constants (`ARENA_X/Z`, `GOAL_HALF`) are sent by the server on connect.
