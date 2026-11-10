# Arham Ashraf — Roblox Game Developer

Portfolio site for Arham Ashraf ([@arhamvertex](https://www.roblox.com/users/11177215064/profile) on Roblox).

It is a static site: plain HTML, CSS and JavaScript with no build step. Open it with any static
server, or host it anywhere that serves files.

## What is in it

- **One sculpture, nine forms.** A WebGL point cloud sits behind the page. As you scroll it
  rearranges itself into a form for each section: a cube, a single vertex, a crystal cluster,
  a ten-storey tower, sound rings, wind, an icosahedron, a globe and an eclipse.
- **Chapters that play like the games.**
  - *Crystal Depths* — click to strike the crystal.
  - *Floor Ten* — scrolling climbs the tower, floor by floor.
  - *Clap to See* — the chapter is dark until you click (clap), which lights it for a moment.
- Smooth scrolling, masked text reveals, a custom cursor, magnetic buttons, a loader and a
  small-screen menu.
- Works without JavaScript, respects "reduce motion", and falls back cleanly without WebGL.

## Run it locally

```sh
python3 -m http.server 4173
# then open http://localhost:4173
```

## Files

| Path | What it does |
| --- | --- |
| `index.html` | All of the content. Edit text, links and games here. |
| `assets/css/main.css` | All styling. Colours and fonts are variables at the top. |
| `assets/js/shapes.js` | The point-cloud forms. |
| `assets/js/scene.js` | The WebGL renderer. |
| `assets/js/main.js` | Scrolling, reveals, chapters, cursor and interactions. |
| `assets/img/` | Game art, favicon and the social share image. |
| `assets/fonts/` | Self-hosted fonts. |

## Common edits

**Add a game to the index.** In `index.html`, find `index__list`, copy one `<li>` and change
the link, number, title, genre and year.

**Add a contact link.** In `index.html`, find `contact__links`. There are commented-out
examples for email and Discord.

**Change a section's sculpture.** Each section has `data-scene="…"`. Use any of: `cube`,
`vertex`, `crystal`, `tower`, `rings`, `wind`, `icosa`, `sphere`, `halo`. Optional attributes:
`data-col-a` / `data-col-b` (colours), `data-bright` (0–1) and `data-label` (the name shown in
the side read-out).

**Move a sculpture.** In `main.css`, set `--ax` (horizontal position), `--ay` (vertical
position) and `--as` (size) on the section.

**Change the accent colour.** Edit `--gold` and `--g1` / `--g2` / `--g3` at the top of
`main.css`.

## Publish on GitHub Pages

1. Merge this branch into your default branch.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch and `/ (root)`.

Once the site has a public address, change `og:image` in `index.html` to the full URL of
`assets/img/og.jpg` so link previews show the image.

## Credits

- Fonts: Cormorant, Manrope and DM Mono, each under the SIL Open Font License.
- Smooth scrolling: [Lenis](https://github.com/darkroomengineering/lenis), MIT License.
- Game data and the Crystal Depths icon come from Arham's public Roblox profile.

This is an independent portfolio. It is not affiliated with or endorsed by Roblox Corporation.
