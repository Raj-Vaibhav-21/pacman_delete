(() => {
  const STEP_MS = 200;
  const MAX_QUEUE = 20;
  const ANGRY_MS = 1500;          // hold Backspace this long -> Pac-Man gets angry
  const ANGRY_SCALE = 1.35;       // angry Pac-Man is this much bigger than normal
  const ANGRY_STEP_MS = 105;       // angry Pac-Man chomps this fast (vs STEP_MS)
  const SELECTION_CHOMP_MS = 320; // duration of the one big chomp for a selection

  // `committedQueue` counts chomps the user explicitly asked for via a fresh
  // keypress — these MUST complete. `totalQueue` is everything still to be
  // processed (committed + speculative self-fed). The difference matters at
  // release time: an in-flight chomp can be cancelled only if it's NOT
  // committed.
  let committedQueue = 0;
  let totalQueue = 0;
  let animating = false;
  let activeEl = null;
  let backspaceHeld = false;
  let holdStart = null;        // timestamp of the first keydown of the current hold
  let selectionAnimating = false; // is the one big selection-chomp in progress?

  // Handles to the in-flight chomp so keyup can cancel it.
  let chompTimeout = null;
  let chompPac = null;

  const TEXT_INPUT_TYPES = new Set([
    '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'
  ]);

  // Style properties copied onto the hidden mirror so its text wraps and
  // measures exactly like the real <input>/<textarea>.
  const MIRROR_PROPS = [
    'boxSizing', 'width', 'height',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'lineHeight', 'fontFamily',
    'textAlign', 'textTransform', 'textIndent', 'textDecoration',
    'letterSpacing', 'wordSpacing', 'tabSize'
  ];

  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has((el.type || '').toLowerCase());
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function findLastTextNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.length > 0) last = node;
    }
    return last;
  }

  function peekCharBeforeCaret(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart;
      if (start == null || start === 0) return null;
      return (el.value || '')[start - 1] || null;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.endContainer;
    const offset = range.endOffset;
    if (node.nodeType !== Node.TEXT_NODE || offset === 0) return null;
    return node.textContent[offset - 1] || null;
  }

  // *** THE FIX FOR THE PARAGRAPH-COLLAPSE REGRESSION ***
  // Old approach: mutate the text node directly, then dispatch an InputEvent
  // with inputType:'deleteContentBackward'. The problem is that
  // `deleteContentBackward` is the exact signal frameworks like Lexical
  // listen for to do their OWN backward delete. So per keypress we deleted
  // one character ourselves, then Lexical deleted another — and when our
  // first deletion left the caret at offset 0 of an empty <p>, Lexical's
  // backward-delete at that position means "merge this paragraph with the
  // previous one." Result: each chomp at a paragraph boundary collapses the
  // block structure.
  //
  // New approach: select the character to be deleted, then call
  // execCommand('delete'). This routes through the browser's editing engine,
  // which fires ONE beforeinput event that the framework handles through
  // its normal pipeline (it understands paragraphs, lists, inline structure,
  // etc.). Manual mutation stays as a fallback for environments where
  // execCommand fails (returns false / throws), and it now dispatches a
  // plain `input` event without the inputType so frameworks don't
  // double-process it.
  function deleteCharBeforeCaret(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const text = el.value || '';
      const start = el.selectionStart;
      if (start == null || start === 0 || !text) return null;
      const ch = text[start - 1];
      const newText = text.slice(0, start - 1) + text.slice(start);
      const proto = el.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, newText);
      try { el.setSelectionRange(start - 1, start - 1); } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return ch;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.endContainer;
    const offset = range.endOffset;
    if (node.nodeType !== Node.TEXT_NODE || offset === 0) return null;

    const ch = node.textContent[offset - 1];

    // Extend the selection one character backward, then ask the browser to
    // delete the selection. Frameworks see this as one canonical edit.
    const charRange = document.createRange();
    charRange.setStart(node, offset - 1);
    charRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(charRange);

    let ok = false;
    try {
      ok = document.execCommand('delete', false, null);
    } catch (_) {}
    if (ok) return ch;

    // Fallback: manual splice, plain input event (no inputType — avoids the
    // double-delete that caused paragraph collapse).
    node.textContent = node.textContent.slice(0, offset - 1) + node.textContent.slice(offset);
    const restored = document.createRange();
    const newOffset = Math.max(0, offset - 1);
    restored.setStart(node, newOffset);
    restored.setEnd(node, newOffset);
    sel.removeAllRanges();
    sel.addRange(restored);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return ch;
  }

  // *** THE FIX FOR THE TYPE-DURING-CHOMP RACE ***
  // A chomp schedules its deletion 200ms in the future. If the user types in
  // that window, the caret moves, and a delete that reads the LIVE caret
  // would eat the just-typed letter instead of the intended one.
  //
  // captureTarget() snapshots WHICH character is being eaten at chomp START.
  // deleteCapturedTarget() deletes exactly that character when the timer
  // fires — re-locating it if typing shifted its offset.

  // Snapshot the character about to be chomped. Returns null if there's
  // nothing valid to delete.
  function captureTarget(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart;
      const text = el.value || '';
      if (start == null || start === 0 || !text) return null;
      return { kind: 'input', index: start - 1, ch: text[start - 1] };
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.endContainer;
    const offset = range.endOffset;
    if (node.nodeType !== Node.TEXT_NODE || offset === 0) return null;
    return { kind: 'ce', node, offset, ch: node.textContent[offset - 1] };
  }

  // Delete the previously-captured character. `t` is a snapshot from
  // captureTarget(). Accounts for the user having typed since the snapshot,
  // AND — critically — leaves the caret wherever the user currently has it.
  // The deletion is deferred ~200ms; in that window the user may have typed,
  // moving their caret. Forcing the caret to the deletion site (the old bug)
  // yanks it backward and scrambles subsequent typing. So: delete the pinned
  // character, then restore the user's caret, shifted left by one ONLY if the
  // deleted character sat before it.
  function deleteCapturedTarget(el, t) {
    if (!t) return null;

    if (t.kind === 'input') {
      const text = el.value || '';
      let idx = t.index;
      // If the character at the captured index no longer matches (the user
      // typed before it, shifting everything right), search for where the
      // captured character moved to — nearest occurrence at or after idx.
      if (text[idx] !== t.ch) {
        const fwd = text.indexOf(t.ch, idx);
        if (fwd !== -1) idx = fwd;
        else return null; // captured character is gone — delete nothing
      }

      // Remember where the user's caret IS right now, before we touch value.
      const liveStart = el.selectionStart;
      const liveEnd = el.selectionEnd;

      const newText = text.slice(0, idx) + text.slice(idx + 1);
      const proto = el.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, newText);

      // Restore the user's caret. A deletion at `idx` shifts every position
      // AFTER idx left by one; positions at or before idx are unaffected.
      try {
        if (liveStart != null && liveEnd != null) {
          const adjust = (p) => (p > idx ? p - 1 : p);
          el.setSelectionRange(adjust(liveStart), adjust(liveEnd));
        } else {
          el.setSelectionRange(idx, idx);
        }
      } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return t.ch;
    }

    // contenteditable. The captured node may have had text inserted into it.
    const node = t.node;
    if (!node || !node.isConnected || node.nodeType !== Node.TEXT_NODE) {
      return null; // node was removed/replaced — give up rather than guess
    }
    const content = node.textContent || '';
    let offset = t.offset;
    // The captured character should sit at offset-1. If the user typed BEFORE
    // it within this same node, it shifted right — re-locate it.
    if (content[offset - 1] !== t.ch) {
      const fwd = content.indexOf(t.ch, Math.max(0, offset - 1));
      if (fwd !== -1) offset = fwd + 1;
      else return null; // captured character is gone — delete nothing
    }
    if (offset === 0) return null;

    const sel = window.getSelection();
    if (!sel) return null;

    // Snapshot the user's CURRENT caret so we can put it back after deleting.
    // (execCommand('delete') would otherwise leave the caret at the deletion
    // site — the same caret-stealing bug as the input path above.)
    let savedCaret = null;
    if (sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (r.collapsed) {
        savedCaret = { node: r.endContainer, offset: r.endOffset };
      }
    }

    // Select exactly the captured character, then route through the editing
    // engine — same canonical-edit path as deleteCharBeforeCaret, so the
    // paragraph-collapse fix still holds.
    const charRange = document.createRange();
    charRange.setStart(node, offset - 1);
    charRange.setEnd(node, offset);
    sel.removeAllRanges();
    sel.addRange(charRange);

    let ok = false;
    try { ok = document.execCommand('delete', false, null); } catch (_) {}
    if (!ok) {
      // Fallback: manual splice.
      node.textContent = content.slice(0, offset - 1) + content.slice(offset);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Put the user's caret back where THEY had it. If their caret was in the
    // same text node and sat after the deleted character, shift it left one.
    if (savedCaret && savedCaret.node && savedCaret.node.isConnected) {
      try {
        let co = savedCaret.offset;
        if (savedCaret.node === node && co > offset - 1) co -= 1;
        const maxOff = (savedCaret.node.textContent || '').length;
        co = Math.max(0, Math.min(co, maxOff));
        const restored = document.createRange();
        restored.setStart(savedCaret.node, co);
        restored.setEnd(savedCaret.node, co);
        sel.removeAllRanges();
        sel.addRange(restored);
      } catch (_) {}
    }
    return t.ch;
  }

  // Delete an entire active selection in one shot (used by the big chomp).
  function deleteSelection(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const v = el.value || '';
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (s == null || e == null || s === e) return;
      const proto = el.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v.slice(0, s) + v.slice(e));
      try { el.setSelectionRange(s, s); } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // contenteditable: route through the browser's editing engine, exactly
    // like the per-character path does. execCommand('delete') over a
    // non-collapsed selection deletes that selection and fires ONE canonical
    // beforeinput that the framework (Lexical/ProseMirror) reconciles through
    // its normal pipeline.
    //
    // *** DO NOT also dispatch a synthetic beforeinput first. ***
    // Frameworks act on that fake event independently and ASYNCHRONOUSLY,
    // which races execCommand and corrupts the edit — net result, nothing
    // deletes. This is the same double-processing class of bug as the old
    // paragraph-collapse regression: one canonical edit path only.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    let ok = false;
    try { ok = document.execCommand('delete', false, null); } catch (_) {}
    if (ok) return;

    // Fallback for environments where execCommand isn't honoured.
    try { sel.getRangeAt(0).deleteContents(); } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function hasSelection(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el.selectionStart !== el.selectionEnd;
    }
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed;
  }

  // A hidden div, styled like `el`, used to measure text geometry that the
  // browser doesn't expose for <input>/<textarea>.
  function createMirrorFor(el) {
    const cs = window.getComputedStyle(el);
    const mirror = document.createElement('div');
    MIRROR_PROPS.forEach(p => { mirror.style[p] = cs[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.style.whiteSpace = el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    return mirror;
  }

  function getCaretRect(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return getMirrorCaretRect(el);
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    let rect = range.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) {
      // Try to measure the char immediately before the caret in its own
      // text node — works for both end-of-line and mid-text positions.
      const node = range.endContainer;
      const offset = range.endOffset;
      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
        const probe = document.createRange();
        probe.setStart(node, offset - 1);
        probe.setEnd(node, offset);
        const charRect = probe.getBoundingClientRect();
        if (charRect.width > 0 || charRect.height > 0) {
          return {
            left: charRect.right,
            top: charRect.top,
            right: charRect.right,
            bottom: charRect.bottom,
            width: 0,
            height: charRect.height
          };
        }
      }
      // Last resort — fall back to the last non-empty text node in the
      // editable. This is the truly-empty-container case.
      const lastText = findLastTextNode(el);
      if (lastText && lastText.textContent.length > 0) {
        const probe = document.createRange();
        const len = lastText.textContent.length;
        probe.setStart(lastText, len - 1);
        probe.setEnd(lastText, len);
        const charRect = probe.getBoundingClientRect();
        if (charRect.width > 0 || charRect.height > 0) {
          return {
            left: charRect.right,
            top: charRect.top,
            right: charRect.right,
            bottom: charRect.bottom,
            width: 0,
            height: charRect.height
          };
        }
      }
      const elRect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.2) || 16;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      rect = {
        left: elRect.left + padL,
        top: elRect.top + padT,
        right: elRect.left + padL,
        bottom: elRect.top + padT + lh,
        width: 0,
        height: lh
      };
    }
    return rect;
  }

  function getMirrorCaretRect(el) {
    const cs = window.getComputedStyle(el);
    const mirror = createMirrorFor(el);

    // Mirror text up to the caret position (not end of value), so this
    // works for mid-text cursors too.
    const value = (el.value || '').substring(0, el.selectionEnd);
    mirror.textContent = value;
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offsetX = markerRect.left - mirrorRect.left;
    const offsetY = markerRect.top - mirrorRect.top;
    const lineHeight = markerRect.height || parseFloat(cs.fontSize) * 1.2;

    document.body.removeChild(mirror);

    const left = elRect.left + offsetX - (el.scrollLeft || 0);
    const top = elRect.top + offsetY - (el.scrollTop || 0);
    return {
      left, top,
      right: left,
      bottom: top + lineHeight,
      width: 0,
      height: lineHeight
    };
  }

  // Bounding rect of the current selection, plus `endX` — the x-coordinate
  // of where the selection actually ENDS (the last line's true right edge).
  // For a ragged multi-line selection the bounding box's right edge is the
  // longest line, which sits over empty space; `endX` is where the text
  // really stops, so Pac-Man can enter from the true end.
  function getSelectionRect(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return getInputSelectionRect(el);
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return null;

    // Collapse a clone of the range to its END point; that zero-width rect
    // sits exactly at the end of the selected text on the last line.
    let endX = box.right;
    try {
      const endRange = range.cloneRange();
      endRange.collapse(false); // false = collapse to end
      const endRect = endRange.getBoundingClientRect();
      if (endRect.height > 0 || endRect.width > 0) endX = endRect.right;
    } catch (_) {}

    return {
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      width: box.width, height: box.height, endX
    };
  }

  function getInputSelectionRect(el) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start == null || end == null || start === end) return null;
    const full = el.value || '';

    const mirror = createMirrorFor(el);
    const m1 = document.createElement('span');
    m1.textContent = '\u200b';
    const m2 = document.createElement('span');
    m2.textContent = '\u200b';
    // [ text before start ][m1][ selected text ][m2]
    mirror.appendChild(document.createTextNode(full.substring(0, start)));
    mirror.appendChild(m1);
    mirror.appendChild(document.createTextNode(full.substring(start, end)));
    mirror.appendChild(m2);
    document.body.appendChild(mirror);

    const r1 = m1.getBoundingClientRect();
    const r2 = m2.getBoundingClientRect();
    const mr = mirror.getBoundingClientRect();
    document.body.removeChild(mirror);

    const elRect = el.getBoundingClientRect();
    const sx = el.scrollLeft || 0;
    const sy = el.scrollTop || 0;

    const top1 = elRect.top + (r1.top - mr.top) - sy;
    const top2 = elRect.top + (r2.top - mr.top) - sy;
    const top = Math.min(top1, top2);
    const bottom = Math.max(
      elRect.top + (r1.bottom - mr.top) - sy,
      elRect.top + (r2.bottom - mr.top) - sy
    );

    // m2 sits right after the last selected character — its x IS the true
    // end of the selection on the last line.
    const left1 = elRect.left + (r1.left - mr.left) - sx;
    const left2 = elRect.left + (r2.left - mr.left) - sx;
    const endX = left2;

    // Multi-line selection -> span the element's content width. Single line
    // -> just the gap between the two markers.
    const multiline = Math.abs(top2 - top1) > 1;
    let left, right;
    if (multiline) {
      const cs = window.getComputedStyle(el);
      left = elRect.left + (parseFloat(cs.paddingLeft) || 0);
      right = elRect.right - (parseFloat(cs.paddingRight) || 0);
    } else {
      left = Math.min(left1, left2);
      right = Math.max(left1, left2);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top, endX };
  }

  function buildPacman() {
    const pac = document.createElement('div');
    pac.className = '__pmd_pacman';
    pac.innerHTML = [
      '<span class="__pmd_jaw __pmd_top">',
        '<span class="__pmd_tooth" style="left:8%"></span>',
        '<span class="__pmd_tooth" style="left:22%"></span>',
        '<span class="__pmd_tooth" style="left:36%"></span>',
        '<span class="__pmd_tooth" style="left:50%"></span>',
      '</span>',
      '<span class="__pmd_jaw __pmd_bottom">',
        '<span class="__pmd_tooth" style="left:15%"></span>',
        '<span class="__pmd_tooth" style="left:29%"></span>',
        '<span class="__pmd_tooth" style="left:43%"></span>',
      '</span>',
      '<span class="__pmd_eye"></span>',
      '<span class="__pmd_anger_mark">\uD83D\uDCA2</span>' // 💢, hidden via CSS unless angry
    ].join('');
    return pac;
  }

  // One big Pac-Man that travels across the selection — entering at the
  // selection's TRUE end and chomping his way to the left start, as if he ate
  // the whole thing — then the selection is removed.
  function bigChomp(el, rect) {
    selectionAnimating = true;

    // Diameter tracks the selection's HEIGHT (a tall paragraph -> a tall
    // Pac-Man), clamped so a Select-All on a huge field stays sane.
    const size = Math.max(28, Math.min(rect.height, window.innerHeight * 0.7));

    const pac = buildPacman();
    pac.style.width = size + 'px';
    pac.style.height = size + 'px';
    pac.style.fontSize = size + 'px';

    // The jaw keyframes are `infinite` at 200ms in CSS. Keep them looping at
    // that rate so he chomps repeatedly while crossing the selection — a
    // travelling eat reads better with several bites than a single one.

    // Vertically centred on the selection block.
    let cy = rect.top + rect.height / 2;
    cy = Math.max(size / 2, Math.min(cy, window.innerHeight - size / 2));
    pac.style.top = (cy - size / 2) + 'px';

    // Horizontal travel. His mouth faces left. He STARTS with his mouth at
    // the selection's TRUE end (rect.endX — where the text actually stops on
    // the last line, NOT the bounding box's right edge, which on a ragged
    // selection sits over empty space) and ENDS at the block's left start.
    const startLeft = rect.endX - size * 0.1;  // mouth at the real text end
    const endLeft = rect.left - size * 0.15;   // finished at the left start
    pac.style.left = startLeft + 'px';
    document.body.appendChild(pac);

    pac.animate(
      [{ left: startLeft + 'px' }, { left: endLeft + 'px' }],
      { duration: SELECTION_CHOMP_MS, easing: 'linear', fill: 'forwards' }
    );

    setTimeout(() => {
      // try/finally guarantees the sprite is removed even if the delete
      // throws — a failed delete must never strand Pac-Man on screen.
      try {
        // Re-check: if focus was lost and the selection cleared during the
        // chomp, don't fall through to deleting a stray character.
        if (hasSelection(el)) deleteSelection(el);
      } catch (_) {
      } finally {
        pac.remove();
        selectionAnimating = false;
      }
    }, SELECTION_CHOMP_MS);
  }

  function abortInFlightIfSpeculative() {
    if (animating && committedQueue === 0 && chompTimeout) {
      clearTimeout(chompTimeout);
      chompTimeout = null;
      if (chompPac) { chompPac.remove(); chompPac = null; }
      animating = false;
      totalQueue = 0;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.isComposing) return;
    const el = e.target;
    if (!isEditable(el)) return;

    // Start (or restart) the angry-timer clock. Only the FIRST keydown of a
    // physical press has e.repeat === false; auto-repeats keep it running.
    // Resetting on every fresh press also self-heals a stale holdStart if a
    // keyup was ever missed.
    if (!e.repeat) holdStart = performance.now();

    // *** SELECTION DELETE -> ONE BIG CHOMP ***
    // A non-collapsed selection (drag-select, Select-All) gets a single
    // Pac-Man sized to the selection that does one chomp, then the whole
    // selection is removed. Handled before the per-character machinery and
    // fully self-contained — it never touches the queue/activeEl state.
    if (hasSelection(el)) {
      if (selectionAnimating) { e.preventDefault(); e.stopPropagation(); return; }
      const rect = getSelectionRect(el);
      if (!rect) return; // couldn't measure — let the browser delete normally
      e.preventDefault();
      e.stopPropagation();
      bigChomp(el, rect);
      return;
    }

    // Already operating on this element — every fresh tap (not auto-repeat)
    // is a new committed chomp. Auto-repeats are filtered: we never let the
    // OS's repeat rate fill our queue.
    if (el === activeEl && (animating || totalQueue > 0)) {
      const ch = peekCharBeforeCaret(el);
      if (!ch) {
        committedQueue = 0; totalQueue = 0; backspaceHeld = false;
        return; // no preventDefault — let native handle paragraph merge
      }
      e.preventDefault();
      e.stopPropagation();
      backspaceHeld = true;
      if (!e.repeat && committedQueue < MAX_QUEUE) {
        committedQueue++;
        totalQueue++;
      }
      return;
    }

    // First-time interaction.
    // *** REMOVED the caretAtEnd() gate ***
    // It was a self-imposed restriction. Pac-Man animating at the caret and
    // chomping the character to its left works just as well in the middle
    // of text — surrounding text simply snaps left to close the gap when
    // the deletion lands, same as native.
    if (!peekCharBeforeCaret(el)) return; // also filters out start-of-block

    e.preventDefault();
    e.stopPropagation();
    activeEl = el;
    committedQueue = 1;
    totalQueue = 1;
    backspaceHeld = true;
    run();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Backspace') return;
    backspaceHeld = false;
    holdStart = null;
    abortInFlightIfSpeculative();
  }, true);

  window.addEventListener('blur', () => {
    backspaceHeld = false;
    holdStart = null;
    abortInFlightIfSpeculative();
  }, true);

  function run() {
    if (animating || totalQueue === 0 || !activeEl) return;
    const el = activeEl;
    const ch = peekCharBeforeCaret(el);
    if (!ch) {
      committedQueue = 0;
      totalQueue = 0;
      activeEl = null;
      return;
    }

    totalQueue--;
    animating = true;

    if (ch === '\n' || ch === '\r') {
      deleteCharBeforeCaret(el);
      if (committedQueue > 0) committedQueue--;
      animating = false;
      if (backspaceHeld && totalQueue === 0) totalQueue = 1;
      requestAnimationFrame(run);
      return;
    }

    const caretRect = getCaretRect(el);
    if (!caretRect) {
      deleteCharBeforeCaret(el);
      if (committedQueue > 0) committedQueue--;
      animating = false;
      if (backspaceHeld && totalQueue === 0) totalQueue = 1;
      requestAnimationFrame(run);
      return;
    }

    // Angry once Backspace has been held past ANGRY_MS: bigger body, red,
    // with a 💢 mark. Computed per chomp, so he flips exactly on threshold.
    const angry = holdStart !== null && (performance.now() - holdStart >= ANGRY_MS);

    // Angry Pac-Man chomps faster. This one value drives BOTH the move
    // animation and the setTimeout that fires the deletion, so the whole
    // chomp cycle scales together.
    const stepMs = angry ? ANGRY_STEP_MS : STEP_MS;

    const baseSize = Math.max(16, caretRect.height * 1.15);
    const size = angry ? baseSize * ANGRY_SCALE : baseSize;
    const pac = buildPacman();
    if (angry) pac.classList.add('__pmd_angry');
    pac.style.width = size + 'px';
    pac.style.height = size + 'px';
    pac.style.fontSize = size + 'px';   // lets the 💢 mark size itself in em
    pac.style.top = (caretRect.top + caretRect.height / 2 - size / 2) + 'px';
    pac.style.left = (caretRect.left - size * 0.1) + 'px';

    // The jaw keyframes are a fixed 200ms in CSS — fine for a normal chomp
    // (STEP_MS is also 200ms, so one open-close == one deletion). For a fast
    // angry chomp, sync the jaw to stepMs too, otherwise the mouth would
    // crawl while the eating races ahead.
    if (angry) {
      pac.querySelectorAll('.__pmd_jaw').forEach(j => {
        j.style.animationDuration = stepMs + 'ms';
      });
    }
    document.body.appendChild(pac);
    chompPac = pac;

    const startX = caretRect.left - size * 0.1;
    const endX = caretRect.left - size * 1.3;
    pac.animate(
      [{ left: startX + 'px' }, { left: endX + 'px' }],
      { duration: stepMs, easing: 'linear', fill: 'forwards' }
    );

    // Pin the target NOW, at chomp-start. The deletion fires `stepMs` later;
    // capturing here means typing in that window can't redirect the chomp
    // onto a freshly-typed character (see captureTarget / deleteCapturedTarget).
    const target = captureTarget(el);

    chompTimeout = setTimeout(() => {
      chompTimeout = null;
      chompPac = null;
      // Delete the character captured at chomp-start, not whatever the live
      // caret points at now.
      deleteCapturedTarget(el, target);
      if (committedQueue > 0) committedQueue--;
      pac.remove();
      animating = false;
      if (backspaceHeld && totalQueue === 0) totalQueue = 1;
      run();
    }, stepMs);
  }
})();