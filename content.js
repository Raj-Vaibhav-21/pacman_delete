(() => {
  const STEP_MS = 200;
  const MAX_QUEUE = 20;

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

  // Handles to the in-flight chomp so keyup can cancel it.
  let chompTimeout = null;
  let chompPac = null;

  const TEXT_INPUT_TYPES = new Set([
    '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'
  ]);

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

  function hasSelection(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return el.selectionStart !== el.selectionEnd;
    }
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed;
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
    const mirror = document.createElement('div');
    const props = [
      'boxSizing', 'width', 'height',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
      'lineHeight', 'fontFamily',
      'textAlign', 'textTransform', 'textIndent', 'textDecoration',
      'letterSpacing', 'wordSpacing', 'tabSize'
    ];
    props.forEach(p => { mirror.style[p] = cs[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.style.whiteSpace = el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';

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
      '<span class="__pmd_eye"></span>'
    ].join('');
    return pac;
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
    if (hasSelection(el)) return;
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
    abortInFlightIfSpeculative();
  }, true);

  window.addEventListener('blur', () => {
    backspaceHeld = false;
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

    const size = Math.max(16, caretRect.height * 1.15);
    const pac = buildPacman();
    pac.style.width = size + 'px';
    pac.style.height = size + 'px';
    pac.style.top = (caretRect.top + caretRect.height / 2 - size / 2) + 'px';
    pac.style.left = (caretRect.left - size * 0.1) + 'px';
    document.body.appendChild(pac);
    chompPac = pac;

    const startX = caretRect.left - size * 0.1;
    const endX = caretRect.left - size * 1.3;
    pac.animate(
      [{ left: startX + 'px' }, { left: endX + 'px' }],
      { duration: STEP_MS, easing: 'linear', fill: 'forwards' }
    );

    chompTimeout = setTimeout(() => {
      chompTimeout = null;
      chompPac = null;
      deleteCharBeforeCaret(el);
      if (committedQueue > 0) committedQueue--;
      pac.remove();
      animating = false;
      if (backspaceHeld && totalQueue === 0) totalQueue = 1;
      run();
    }, STEP_MS);
  }
})();