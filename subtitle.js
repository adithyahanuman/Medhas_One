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
    return;
  }

  /**
   * Highlight the word whose character range covers `charIndex`.
   * Driven by the TTS onboundary event.
   *
   * @param {number} charIndex   charIndex from SpeechSynthesisEvent
   * @param {number} charLength  word length (may be 0 on some browsers)
   */
  highlight(charIndex, charLength) {
    return;
  }

  /**
   * Remove highlight and fade the subtitle bar out after a short delay.
   * Safe to call multiple times.
   */
  clear() {
    }, 1400);
  }
}
