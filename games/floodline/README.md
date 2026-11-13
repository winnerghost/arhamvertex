# Floodline

A first-person tactical shooter where the tide is the zone. Water rises in surges, and a glowing
line on the ground shows where the next surge will reach. The low ground floods first, so every
match ends in a fight on the last high ground.

Runs in the browser with three.js. Everything else is made in code: textures, models, sound and
music. Opponents and teammates are bots.

## Modes

| Mode | Map | Players | Format |
| --- | --- | --- | --- |
| Arena 1v1, 2v2, 3v3, 4v4 | Spillway | 2 to 8 | Elimination rounds, first to 3. The tide resets every round. |
| Royale Solo, Duos, Squads | Saltreach | 24 | Drop from the sky, loot, fight. Nine surges flood the island up to The Summit. |

Bot difficulty is Recruit, Regular or Veteran. In Arena you pick a primary weapon: Tern-7 rifle,
Wasp SMG, Breaker 12 shotgun or Heron .338 marksman rifle. Everyone also carries a Mako P9 pistol.

## Run it locally

It is a static site. Serve the repository root and open the folder:

```sh
python3 -m http.server 4173
# then open http://localhost:4173/games/floodline/
```

It needs an internet connection to load three.js and the fonts from their CDNs.

## Controls

| Key | Action |
| --- | --- |
| W A S D | Move |
| Shift | Sprint, or dive during the drop |
| C | Crouch, or slide while sprinting |
| Space | Jump, or swim up |
| Mouse | Aim and fire. Hold the right button to aim down sights. |
| R | Reload |
| 1 2 3 or wheel | Switch weapon |
| E | Pick up, or open a supply case |
| H | Use a patch kit (+50 health) |
| G | Throw a frag grenade |
| Tab | Scoreboard |
| M | Island map (Royale) |
| Esc | Pause |

## Files

| Path | What it does |
| --- | --- |
| `index.html` | Menus, HUD markup and all styling |
| `js/main.js` | Boot, menus, settings, pointer lock and the main loop |
| `js/game.js` | Match rules, physics, hitscan combat, tide, loot, grenades |
| `js/player.js` | Player input, movement, aiming, recoil and camera |
| `js/bots.js` | Bot perception, aim model, combat movement, looting, rotations |
| `js/world.js` | Terrain, collision boxes, raycasts and the navigation grid |
| `js/maps.js` | The Spillway and Saltreach layouts and tide schedules |
| `js/render.js` | Renderer, sky, water shader, floodline material patch, post-processing |
| `js/characters.js` | Soldier models with procedural animation and IK arms |
| `js/weapons.js` | Weapon stats, gun models and the first-person viewmodel |
| `js/fx.js` | Particles, tracers, decals, ripples, explosions and rain |
| `js/audio.js` | Synthesized gunshots, ambience, the tide horn and music |
| `js/hud.js` | HUD, compass, minimap, depth staff, kill feed and island map |
| `js/textures.js` | Procedural textures |
