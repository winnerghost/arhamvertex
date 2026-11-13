# Floodline

A first-person tactical shooter where the tide is the zone. Water rises in surges, and a glowing
line on the ground shows where the next surge will reach. The low ground floods first, so every
match ends in a fight on the last high ground.

Runs in the browser and as an Android app, with three.js. Everything else is made in code: textures,
models, sound and music. Play against bots, or online with friends using a room code.

## Modes

| Mode | Map | Players | Format |
| --- | --- | --- | --- |
| Arena 1v1, 2v2, 3v3, 4v4 | Spillway | 2 to 8 | Elimination rounds, first to 3. The tide resets every round. |
| Royale Solo, Duos, Squads | Saltreach | 24 | Drop from the sky, loot, fight. Nine surges flood the island up to The Summit. |

Bot difficulty is Recruit, Regular or Veteran. In Arena you pick a primary weapon: Tern-7 rifle,
Wasp SMG, Breaker 12 shotgun or Heron .338 marksman rifle. Everyone also carries a Mako P9 pistol.

## Android app

`floodline.apk` in this folder is the Android app. Download it on the phone, open it, and allow
installing from that source when Android asks. It needs Android 6 or newer and runs in landscape.
The game is packed inside the app, so offline matches against bots need no internet; online rooms do.

Each build is signed with a locally generated key that isn't stored in this repository. If a newer
APK refuses to install over an older one, uninstall the old app first.

## Playing with friends

1. One player opens **Play → Host a room**. The lobby shows a 5-character room code.
2. Friends open **Play → Join a room**, type the code and join. Phones, tablets and computers can
   all join the same room. Up to 8 people fit in a room, and bots fill every empty slot.
3. The host picks the mode (1v1 to 4v4, or royale solo, duos or squads) and whether friends play
   **against each other** or **on the same team**, then starts the match.
4. After a match the host can take everyone back to the room for another one.

Connections are peer-to-peer (WebRTC). The free public PeerJS server introduces the players to
each other, and the host's device runs the match. If a friend can't connect, try both players on
the same Wi-Fi, or put one on mobile data. If a friend leaves mid-match, a bot takes their place.

## Touch controls

On phones and tablets the left side of the screen is a movement stick (push it all the way up to
sprint), and dragging anywhere on the right turns the view. The large orange button fires and can
be dragged to aim while firing. Other buttons aim down sights, jump, crouch or slide, reload,
switch weapon, throw a grenade and use a patch kit. A pick-up button appears next to loot. Touch
players get a gentle aim assist. Touch controls can be forced on or off in Settings.

## Run it locally

It is a static site. Serve the repository root and open the folder:

```sh
python3 -m http.server 4173
# then open http://localhost:4173/games/floodline/
```

It needs an internet connection to load three.js, PeerJS and the fonts from their CDNs.

## Build the offline package and the APK

```sh
npm install esbuild@0.23.1 three@0.170.0 peerjs@1.5.4 \
  @fontsource/barlow-condensed@5.0.13 @fontsource/barlow@5.0.13 @fontsource/big-shoulders-stencil-display@5.0.13
node build.mjs node_modules dist          # dist/index.html + dist/game.js, fully offline
keytool -genkeypair -keystore floodline.keystore -storepass floodline -keypass floodline \
  -alias floodline -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Floodline"
android/build_apk.sh dist floodline.apk floodline.keystore
```

The APK build uses the Android platform, aapt2, dx, zipalign and apksigner from Ubuntu's
`android-sdk-platform-23`, `android-sdk-build-tools`, `dalvik-exchange`, `zipalign` and `apksigner`
packages, so it needs no Gradle and no Android Studio.

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

On touch screens, see [Touch controls](#touch-controls).

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
| `js/net.js` | Online rooms: room codes, lobby and peer-to-peer messaging |
| `js/touch.js` | Touch controls |
| `build.mjs` | Bundles the game into an offline package |
| `android/` | The Android app shell and its build script |
| `floodline.apk` | The Android app |
| `js/textures.js` | Procedural textures |
