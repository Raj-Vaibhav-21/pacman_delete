# Pac-Man Delete

A Chrome extension that sends Pac-Man across your screen to chomp characters as you backspace, on any web page.

![demo](demo.gif)

> Add a `demo.gif` to the repo root to make the image above appear. [Kap](https://getkap.co/) (macOS), [ScreenToGif](https://www.screentogif.com/) (Windows), and [peek](https://github.com/phw/peek) (Linux) all work.

## Features

- Animated Pac-Man chomps each character as you delete it
- Works in plain `<input>` and `<textarea>` fields
- Works in `contenteditable` editors, including rich-text frameworks like Lexical (used by Claude, Gemini, and others)
- Preserves block structure — paragraphs, line breaks, and lists don't get collapsed when deleting near their boundaries
- No overshoot when holding Backspace — chomps stop within one cycle of releasing the key
- Works mid-text, not just at the end of a line

## Installation

This extension is not on the Chrome Web Store yet. To install it locally:

1. Clone or download this repository.
   ```bash
   git clone https://github.com/Raj-Vaibhav-21/pacman_delete.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the cloned folder.
5. Open any page with a text field and start backspacing.

Also works in Chromium-based browsers (Edge, Brave, Arc, Opera) via the same flow.

## How it works

The extension injects a content script (`content.js`) into every page. The script:

- Listens for `Backspace` keypresses on editable elements.
- Computes the caret's screen position — using DOM `Range` geometry for `contenteditable`, and a hidden mirror element for `<input>`/`<textarea>` (which don't expose caret coordinates directly).
- Spawns a Pac-Man `<div>` styled with pure CSS keyframe animations for the chomping mouth.
- Animates the sprite leftward over `STEP_MS` (200ms) and then deletes one character.
- For `contenteditable`, deletion is routed through `document.execCommand('delete')` so rich-text frameworks see a single canonical edit and update their internal model correctly. Direct DOM mutation is a fallback for environments where `execCommand` isn't honored.

The animation queue uses a two-counter design (`committedQueue` for keypresses the user explicitly made, `totalQueue` including speculative self-fed chomps during a hold) so that releasing the key cancels any speculative work in flight without dropping committed chomps.

## Tested on

- Claude (Lexical editor)
- Gemini
- ChatGPT
- Plain `<textarea>` and `<input>` fields across various sites
- GitHub issue/PR description fields

If you find a site where it misbehaves, open an issue.

## Known limitations

- Backspace deletes characters one at a time — `Ctrl+Backspace` (delete word) falls through to native handling, so no animation for word deletions.
- Forward `Delete` key is not animated.
- Heavy custom editors (CodeMirror, Monaco, Slate) may not be detected as standard `contenteditable` and will fall back to native deletion silently.
- The animation runs at a fixed 200ms per character, which is slower than a fast typist's hold-to-delete speed. This is intentional — it's the point — but if you need to delete a lot of text quickly, select-and-backspace still works normally.

## Configuration

Edit the top of `content.js`:

```js
const STEP_MS = 200;    // ms per chomp — lower = faster Pac-Man
const MAX_QUEUE = 20;   // safety cap on queued chomps
```

After editing, reload the page (or the extension card at `chrome://extensions`) to pick up changes.

## Project structure

```
pacman_delete/
├── manifest.json   # extension manifest (Manifest V3)
├── content.js      # injected script — all the logic lives here
├── content.css     # Pac-Man styling and chomp keyframes
└── README.md
```

## License

MIT — see `LICENSE` file if present, or use freely.

## Contributing

Issues and PRs welcome. If you're reporting a bug, please include:

- The site/URL where it happened
- What the editor is (plain textarea, Lexical, custom, etc. — check the DOM if you can)
- What you typed/deleted and what went wrong
- A screenshot or screen recording if visual

---

Built as a side project. Not affiliated with Bandai Namco or anyone who owns Pac-Man.
