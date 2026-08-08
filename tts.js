/**
 * tts.js — MEDHAS TTS Engine with sentence queue
 *
 * Wraps SpeechSynthesis with:
 *   • A FIFO sentence queue — speak() enqueues; sentences play back-to-back.
 *   • Word-boundary events for subtitle sync.
 *   • Synthesised amplitude signal from boundary cadence.
 *   • onQueueEmpty callback for when all sentences finish.
 *   • cancel() drains the queue and stops all speech immediately.
 */

/**
 * Strips markdown symbols, code fences, URLs, and unwanted formatting characters
 * so Text-To-Speech speaks natural, clean sentences without saying "asterisk", "backtick", etc.
 */
export function cleanTextForSpeech(text) {
  if (!text) return '';

  return text
    // 1. Remove code blocks (```...```)
    .replace(/```[\s\S]*?```/g, ' ')
    // 2. Remove inline code (`...`)
    .replace(/`([^`]+)`/g, '$1')
    // 3. Remove URLs (https://... or http://...)
    .replace(/https?:\/\/\S+/gi, '')
    // 4. Convert markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // 5. Remove bold/italic markers (**text**, *text*, __text__, _text_)
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // 6. Remove header markers (#, ##, ###)
    .replace(/^#{1,6}\s+/gm, '')
    // 7. Remove bullet points (* item, - item, + item)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // 8. Remove numbered list prefixes (1. item, 2. item)
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // 9. Remove blockquotes (> text)
    .replace(/^[\s]*>\s+/gm, '')
    // 10. Remove remaining unwanted symbols like *, _, `, ~, #, ^, |, \, <, >
    .replace(/[*_`~#^|\\<>]/g, ' ')
    // 11. Normalize multiple spaces & newlines into natural spoken pauses
    .replace(/\s+/g, ' ')
    .trim();
}

export class TTSEngine {
  #queue        = [];   // pending { text, cbs } items
  #playing      = false;
  #decayTimer   = null;
  #resumeTimer  = null;
  #onQueueEmpty = null; // registered externally for sentence-streaming reset

  // ── Preferred female voice names (tried in order) ────────────────────────
  static #PREFERRED_FEMALE_VOICES = [
    'Google UK English Female',
    'Google US English',
    'Microsoft Jenny Online (Natural)',
    'Microsoft Aria Online (Natural)',
    'Microsoft Zira',
    'Samantha',
    'Karen',
    'Victoria',
    'Fiona',
    'Moira',
    'Tessa',
    'Zira',
    'Female',
  ];

  constructor() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.getVoices(); // pre-trigger async voice load
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }

  get isSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  speak(text, { onWord = () => {}, onAmplitude = () => {}, onEnd = () => {}, onError = () => {} } = {}) {
    if (!this.isSupported) {
      onError('SpeechSynthesis is not supported in this browser.');
      setTimeout(onEnd, 0);
      return;
    }

    const cleaned = cleanTextForSpeech(text);
    if (!cleaned) { setTimeout(onEnd, 0); return; }

    this.#queue.push({ text: cleaned, cbs: { onWord, onAmplitude, onEnd, onError } });
    if (!this.#playing) this.#processQueue();
  }

  onQueueEmpty(cb) {
    this.#onQueueEmpty = cb;
  }

  cancel() {
    this.#queue    = [];
    this.#playing  = false;
    this.#onQueueEmpty = null;
    clearInterval(this.#resumeTimer);
    clearTimeout(this.#decayTimer);
    this.#resumeTimer = null;
    this.#decayTimer  = null;
    if (this.isSupported) window.speechSynthesis.cancel();
  }

  #processQueue() {
    if (this.#queue.length === 0) {
      this.#playing = false;
      const cb = this.#onQueueEmpty;
      this.#onQueueEmpty = null;
      cb?.();
      return;
    }

    this.#playing = true;
    const { text, cbs } = this.#queue.shift();
    this.#speakOne(text, cbs, () => this.#processQueue());
  }

  #speakOne(text, { onWord, onAmplitude, onEnd, onError }, onFinished) {
    const utter = new SpeechSynthesisUtterance(text);

    utter.rate   = 1.35; // Fast, crisp female reading speed
    utter.pitch  = 1.15; // Bright female pitch
    utter.volume = 1.0;

    const voice = this.#pickVoice();
    if (voice) utter.voice = voice;

    utter.onboundary = (e) => {
      if (e.name !== 'word') return;
      const charIdx = e.charIndex;
      const charLen = (e.charLength != null && e.charLength > 0)
        ? e.charLength
        : this.#wordLengthAt(text, charIdx);
      onWord(charIdx, charLen);
      const spike = 0.55 + Math.random() * 0.40;
      onAmplitude(spike);
      clearTimeout(this.#decayTimer);
      this.#decayTimer = setTimeout(() => onAmplitude(0.10), 180);
    };

    clearInterval(this.#resumeTimer);
    this.#resumeTimer = setInterval(() => {
      if (!window.speechSynthesis.speaking) { clearInterval(this.#resumeTimer); return; }
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }, 12_000);

    const cleanup = () => {
      clearInterval(this.#resumeTimer);
      clearTimeout(this.#decayTimer);
      this.#resumeTimer = null;
      this.#decayTimer  = null;
      onAmplitude(0);
    };

    utter.onend = () => {
      cleanup();
      onEnd();
      onFinished();
    };

    utter.onerror = (e) => {
      cleanup();
      if (e.error === 'interrupted' || e.error === 'canceled') {
        onEnd();
      } else {
        onError(`TTS error: ${e.error}`);
      }
      onFinished();
    };

    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    window.speechSynthesis.speak(utter);
  }

  #pickVoice() {
    if (!this.isSupported) return null;
    let voices = window.speechSynthesis.getVoices();
    if (!voices || !voices.length) {
      window.speechSynthesis.getVoices();
      voices = window.speechSynthesis.getVoices();
    }
    if (!voices || !voices.length) return null;

    // 1. Try preferred female list
    for (const name of TTSEngine.#PREFERRED_FEMALE_VOICES) {
      const v = voices.find(v => v.name.toLowerCase().includes(name.toLowerCase()));
      if (v) return v;
    }

    // 2. Try any voice with 'female' in name
    const femaleAny = voices.find(v => v.name.toLowerCase().includes('female') || v.name.toLowerCase().includes('zira') || v.name.toLowerCase().includes('samantha'));
    if (femaleAny) return femaleAny;

    // 3. Fallback: pick any English voice that is NOT explicitly male (David, Mark, George, Male)
    const MALE_NAMES = ['david', 'mark', 'george', 'james', 'richard', 'male'];
    const nonMaleEn = voices.find(v => v.lang.startsWith('en') && !MALE_NAMES.some(m => v.name.toLowerCase().includes(m)));
    if (nonMaleEn) return nonMaleEn;

    return voices.find(v => v.lang.startsWith('en')) ?? voices[0] ?? null;
  }

  #wordLengthAt(text, charIdx) {
    let end = charIdx;
    while (end < text.length && !/\s/.test(text[end])) end++;
    return end - charIdx;
  }
}
