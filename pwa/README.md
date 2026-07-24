# @tokenflare/pwa

The phone display. **Plain HTML + CSS + vanilla JavaScript — no build step.**

Open `http://<pc-ip>:7331/` on the phone and add it to the home screen. The
manifest forces **landscape + fullscreen**.

## Files

| File | Role |
|---|---|
| `index.html` | shell: hero-left, quota-grid-right, settings overlay |
| `manifest.webmanifest` | landscape, fullscreen, standalone |
| `sw.js` | service worker — caches the app shell for offline relaunch |
| `styles/base.css` | neon-dark default tokens + animated background |
| `styles/themes.css` | 5 color-pack themes (Nord, Tokyo Night, Catppuccin, Gruvbox, Synthwave) |
| `styles/components.css` | hero, quota cards, glowing bars, settings panel |
| `js/client.js` | WebSocket client — snapshot/delta + auto-reconnect |
| `js/render.js` | snapshot/delta → DOM |
| `js/settings.js` | theme/font/background/motion/server prefs (localStorage) |
| `js/app.js` | entry — wires client + render + settings |
| `types.d.ts` | shared types (editor intellisense only, not compiled) |

## Customization

Tap the ⚙ gear (bottom-left of the hero):

- **Theme** — Neon Dark (default), Nord, Tokyo Night, Catppuccin, Gruvbox, Synthwave.
- **Font** — JetBrains Mono (default), Inter, System.
- **Background** — Gradient Mesh (default), Aurora, None.
- **Reduced motion** — freezes all animations (also auto-on if the OS prefers reduced motion).
- **Server** — the `ws://` URL (defaults to the page origin).

Preferences are stored in `localStorage` on the phone only — nothing is sent to the server.

## Layout

```
+--------------------------+-----------------------------+
|  HERO (40%)              |  QUOTA GRID (60%)           |
|  ● RUNNING               |  Codex 5h   ████░░ 78%      |
|  Refactoring auth        |  Codex 7d   █████░ 91%      |
|  tokenflare            |  Resets     2 left          |
|  04:12                   |  Claude 5h  ██░░░░ 38%      |
|  12:34  ⚙                |  Claude 7d  ████░░ 67%      |
+--------------------------+-----------------------------+
```
