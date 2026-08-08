/**
 * subtitle.js — MEDHAS Phase 1 Word-Synced Subtitle Controller
 *
 * Parses response text into individual word <span> elements and highlights
 * whichever word is currently being spoken (driven by TTS onboundary events).
 *
 * Usage:
 *   const subtitle = new SubtitleController('#subtitle-words');
 *   subtitle.set('Hello world, how are you?');   // renders word spans
 *   subtitle.highlight(6, 5);                    // highlights "world"
 *   subtitle.clear();                            // fades out after 1.2 s
 */

export class SubtitleController {
  /** @type {HTMLElement|null} */
  #container = null;

  /**
   * @type {Array<{
   *   charStart: number,
   *   charEnd:   number,
   *   el:        HTMLSpanElement|null
   * }>}
   */
  #words = [];

  /** Index of the currently highlighted word, or -1. */
  #activeIdx = -1;

  /** Timer for the delayed clear (fade-out). */
  #clearTimer = null;

  /**
   * @param {string} selector  CSS selector for the container element.
   */
  constructor(selector) {
    this.#container = document.querySelector(selector);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Parse `text` into word spans and render them into the container.
   * Call this once per response, before the TTS starts.
   *
   * @param {string} text
   */
  set(text) {
    if (!this.#container) return;

    clearTimeout(this.#clearTimer);
    this.#words    = [];
    this.#activeIdx = -1;

    // Build HTML: each non-whitespace token → <span class="sub-word">
    // Whitespace between words is preserved as raw text nodes.
    const fragment = document.createDocumentFragment();
    const wordRe   = /(\S+)(\s*)/g;
    let   match;

    while ((match = wordRe.exec(text)) !== null) {
      const wordText  = match[1];
      const spaceText = match[2];
      const charStart = match.index;
      const charEnd   = charStart + wordText.length;

      const span = document.createElement('span');
      span.className   = 'sub-word';
      span.dataset.idx = String(this.#words.length);
      span.textContent = wordText;

      this.#words.push({ charStart, charEnd, el: span });
      fragment.appendChild(span);

      if (spaceText) {
        fragment.appendChild(document.createTextNode(spaceText));
      }
    }

    this.#container.innerHTML = '';
    this.#container.appendChild(fragment);
    this.#container.closest('#subtitle-bar')?.classList.add('active');
  }

  /**
   * Highlight the word whose character range covers `charIndex`.
   * Driven by the TTS onboundary event.
   *
   * @param {number} charIndex   charIndex from SpeechSynthesisEvent
   * @param {number} charLength  word length (may be 0 on some browsers)
   */
  highlight(charIndex, charLength) {
    if (!this.#words.length) return;

    // De-highlight previous word
    if (this.#activeIdx >= 0) {
      this.#words[this.#activeIdx]?.el?.classList.remove('active');
    }

    // Find the word whose span covers charIndex
    let found = -1;

    for (let i = 0; i < this.#words.length; i++) {
      const w = this.#words[i];
      if (charIndex >= w.charStart && charIndex < w.charEnd) {
        found = i;
        break;
      }
    }

    // Fallback: if charIndex falls in whitespace, use the next word
    if (found === -1) {
      for (let i = 0; i < this.#words.length; i++) {
        if (this.#words[i].charStart >= charIndex) {
          found = i;
          break;
        }
      }
    }

    // Ultimate fallback: last word (for trailing boundary events)
    if (found === -1) found = this.#words.length - 1;

    this.#activeIdx = found;
    const el = this.#words[found]?.el;
    if (el) {
      el.classList.add('active');
      // Ensure the active word scrolls into view if the bar overflows
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  /**
   * Remove highlight and fade the subtitle bar out after a short delay.
   * Safe to call multiple times.
   */
  clear() {
    if (this.#activeIdx >= 0) {
      this.#words[this.#activeIdx]?.el?.classList.remove('active');
      this.#activeIdx = -1;
    }

    const bar = this.#container?.closest('#subtitle-bar');
    bar?.classList.remove('active');

    clearTimeout(this.#clearTimer);
    this.#clearTimer = setTimeout(() => {
      if (this.#container) this.#container.innerHTML = '';
      this.#words = [];
    }, 1400);
  }
}
