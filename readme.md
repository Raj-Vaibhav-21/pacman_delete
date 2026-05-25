# Pac-Man Delete

A Chrome extension that sends Pac-Man across your screen to chomp characters as you backspace, on any web page.

![demo](demo.gif)

> Add a `demo.gif` to the repo root to make the image above appear. [Kap](https://getkap.co/) (macOS), [ScreenToGif](https://www.screentogif.com/) (Windows), and [peek](https://github.com/phw/peek) (Linux) all work.

## Features

- Animated Pac-Man chomps each character as you delete it
- Works in plain `<input>` and `<textarea>` fields
- Works in `contenteditable` editors, including rich-text frameworks like Lexical and ProseMirror (used by Claude, ChatGPT, Gemini, and others)
- Preserves block structure — paragraphs, line breaks, and lists don't get collapsed when deleting near their boundaries
- Works mid-text, not just at the end of a line — click anywhere and backspace
- No overshoot when holding Backspace — chomps stop within one cycle of releasing the key
- Typing mid-chomp is safe — the deletion lands on the correct character even if you type in the 200ms animation window
- **Angry mode** — hold Backspace for 1.5 seconds and Pac-Man turns red, grows bigger, gets a 💢 mark, and chomps faster
- **Selection chomp** — select a word, sentence, or entire paragraph and press Backspace; a Pac-Man sized to your selection sweeps in from the end of the text and devours it in one go

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

- Listens for `Backspace` keypresses on editable elements (`<input>`, `<textarea>`, `contenteditable`).
- Computes the caret's screen position — using DOM `Range` geometry for `contenteditable`, and a hidden mirror element for `<input>`/`<textarea>` (which don't expose caret coordinates directly).
- Spawns a Pac-Man `<div>` styled with pure CSS keyframe animations for the chomping mouth.
- Animates the sprite leftward over `STEP_MS` (200ms) and then deletes the character that was before the caret at the moment the chomp started — not at the moment the timer fires. This is what makes typing mid-chomp safe: the target is pinned up front, and the caret is restored to wherever the user moved it in the meantime.
- For `contenteditable`, deletion is routed through `document.execCommand('delete')` so rich-text frameworks see a single canonical edit and update their internal model correctly. Direct DOM mutation is a fallback for environments where `execCommand` isn't honoured.

**Angry mode** is driven by a `holdStart` timestamp set on the first `keydown` of each hold. Each chomp checks `performance.now() - holdStart` against `ANGRY_MS` (1500ms). Once crossed, Pac-Man gets the `__pmd_angry` CSS class (red body, 💢 mark), is scaled up by `ANGRY_SCALE` (1.35×), and the jaw animation duration and move animation are both switched to `ANGRY_STEP_MS` (130ms) so the mouth visibly chomps faster too.

**Selection chomp** measures the bounding rect of the current selection — using `Range.getBoundingClientRect()` for `contenteditable`, and a hidden mirror with two zero-width markers for `<input>`/`<textarea>`. Critically, the start position for the sweep is the selection's *true end* (where the text actually stops on the last line), not the bounding box's right edge, which on a ragged multi-line selection sits over empty space. The selection is deleted via `execCommand('delete')` after the animation completes.

The animation queue uses a two-counter design (`committedQueue` for keypresses the user explicitly made, `totalQueue` including speculative self-fed chomps during a hold) so that releasing the key cancels any speculative work in flight without dropping committed chomps.

## Tested on

- Claude (Lexical editor)
- ChatGPT (ProseMirror editor)
- Gemini
- Plain `<textarea>` and `<input>` fields across various sites
- GitHub issue/PR description fields

If you find a site where it misbehaves, open an issue.

## Known limitations

- Backspace deletes characters one at a time — `Ctrl+Backspace` (delete word) falls through to native handling, so no animation for word deletions.
- Forward `Delete` key is not animated.
- Heavy custom editors (CodeMirror, Monaco, Slate) may not be detected as standard `contenteditable` and will fall back to native deletion silently. LeetCode's Monaco-based editor falls into this category.
- Some sites (WhatsApp Web, LinkedIn) use non-standard editable structures or load their editors in cross-origin iframes; the extension may not activate on those inputs.
- The animation runs at 200ms per character (normal) or 130ms (angry), which is slower than a fast typist's raw hold-to-delete speed. This is intentional — it's the point. Select-and-backspace for bulk deletion triggers the selection chomp instead.

## Configuration

Edit the constants at the top of `content.js`:

```js
const STEP_MS = 200;         // ms per chomp — lower = faster Pac-Man
const MAX_QUEUE = 20;        // safety cap on queued chomps
const ANGRY_MS = 1500;       // hold this long (ms) to trigger angry mode
const ANGRY_SCALE = 1.35;    // angry Pac-Man size multiplier
const ANGRY_STEP_MS = 130;   // ms per chomp in angry mode — lower = faster
const SELECTION_CHOMP_MS = 320; // duration of the selection sweep animation
```

After editing, reload the extension card at `chrome://extensions`, then hard-reload the page you're testing on. Content scripts inject at page load — tabs already open keep the old script in memory.

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
- What the editor is (plain textarea, Lexical, ProseMirror, custom, etc. — check the DOM if you can)
- What you typed/deleted and what went wrong
- A screenshot or screen recording if visual

---

Built as a side project. Not affiliated with Bandai Namco or anyone who owns Pac-Man.
