/**
 * liveSession.js — MEDHAS Gemini Multimodal Live API Client
 *
 * Manages a PERSISTENT WebSocket session with auto-reconnect so
 * real Gemini AI responses are always available.
 *
 * Features:
 *  - Auto-reconnect with exponential back-off (max 30 s)
 *  - Keep-alive ping every 20 s to prevent idle disconnection
 *  - 16 kHz PCM microphone streaming → Live API
 *  - 24 kHz PCM audio playback with real-time amplitude
 *  - Text & image input in the same session
 *  - Barge-in (interrupt playback on new input)
 */

export class LiveSessionManager {
  // ── WebSocket ──────────────────────────────────────────────────────────────
  #ws              = null;
  #reconnectTimer  = null;
  #keepAliveTimer  = null;
  #reconnectDelay  = 1000;   // ms — doubles on each failure, max 30 s
  #maxDelay        = 30_000;
  #intentionallyClosed = false;

  // ── Audio context & playback ──────────────────────────────────────────────
  #audioCtx      = null;
  #analyser      = null;
  #activeSources = [];
  #nextPlayTime  = 0;

  // ── Microphone recording ──────────────────────────────────────────────────
  #recordingStream = null;
  #processorNode   = null;
  #recAudioCtx     = null;

  // ── Callbacks ─────────────────────────────────────────────────────────────
  #orb           = null;
  #onStateChange = null;
  #onTranscript  = null;
  #onError       = null;

  // ── Text reply buffer (accumulates partial text turns) ───────────────────
  #textBuffer = '';

  constructor({ orb, onStateChange, onTranscript, onError }) {
    this.#orb           = orb;
    this.#onStateChange = onStateChange;
    this.#onTranscript  = onTranscript;
    this.#onError       = onError;
  }

  // ── Public: connection state ──────────────────────────────────────────────

  get isConnected() {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  // ── Public: connect (starts persistent session with auto-reconnect) ───────

  async connect() {
    this.#intentionallyClosed = false;
    return this.#doConnect();
  }

  async #doConnect() {
    // Determine ws URL
    let wsHost   = location.host || 'localhost:3000';
    let protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const backendConfig = window.MEDHAS_BACKEND_URL || localStorage.getItem('medhas_backend_url');
    if (backendConfig) {
      try {
        const bUrl = new URL(backendConfig);
        protocol = bUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsHost = bUrl.host;
      } catch {}
    } else if (location.protocol === 'file:' || !location.host) {
      protocol = 'ws:';
      wsHost   = 'localhost:3000';
    }
    const wsUrl = `${protocol}//${wsHost}/api/live`;

    return new Promise((resolve, reject) => {
      if (this.#intentionallyClosed) return reject(new Error('Session closed intentionally.'));

      try {
        this.#ws = new WebSocket(wsUrl);
      } catch (err) {
        this.#scheduleReconnect();
        return reject(err);
      }

      // Resolve as soon as the socket opens
      let settled = false;

      this.#ws.onopen = () => {
        console.log('[LiveSession] ✅ Connected to Gemini Live relay.');
        this.#reconnectDelay = 1000;  // reset back-off on success
        this.#startKeepAlive();
        this.#initAudioContext();
        if (!settled) { settled = true; resolve(true); }
      };

      this.#ws.onmessage = (evt) => this.#handleMessage(evt.data);

      this.#ws.onerror = (err) => {
        console.warn('[LiveSession] WebSocket error — will reconnect.');
        if (!settled) { settled = true; reject(err); }
      };

      this.#ws.onclose = (evt) => {
        console.log(`[LiveSession] Connection closed (${evt.code}). Reconnecting…`);
        this.#stopKeepAlive();
        this.#onStateChange?.('idle');
        if (!settled) { settled = true; reject(new Error(`WS closed: ${evt.code}`)); }
        if (!this.#intentionallyClosed) this.#scheduleReconnect();
      };
    });
  }

  // ── Reconnect with exponential back-off ────────────────────────────────────

  #scheduleReconnect() {
    if (this.#intentionallyClosed) return;
    clearTimeout(this.#reconnectTimer);
    const delay = this.#reconnectDelay;
    console.log(`[LiveSession] Reconnecting in ${delay / 1000}s…`);
    this.#reconnectTimer = setTimeout(async () => {
      try {
        await this.#doConnect();
        console.log('[LiveSession] Reconnection successful.');
      } catch {
        // #doConnect's onclose will schedule the next attempt
      }
    }, delay);
    // Double the delay, capped at max
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, this.#maxDelay);
  }

  // ── Keep-alive ping to prevent Google's idle timeout ─────────────────────

  #startKeepAlive() {
    // Keep-alive disabled — Gemini Live API manages its own session lifetime.
    // Any unexpected message (even a valid empty one) causes code 1000 close.
    this.#stopKeepAlive();
  }

  #stopKeepAlive() {
    clearInterval(this.#keepAliveTimer);
    this.#keepAliveTimer = null;
  }

  // ── Audio Context ─────────────────────────────────────────────────────────

  #initAudioContext() {
    if (!this.#audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.#audioCtx = new Ctx({ sampleRate: 24000 });
      this.#analyser = this.#audioCtx.createAnalyser();
      this.#analyser.fftSize = 256;
      this.#analyser.connect(this.#audioCtx.destination);
    }
    if (this.#audioCtx.state === 'suspended') {
      this.#audioCtx.resume().catch(e => console.warn('[LiveSession] AudioContext resume failed:', e));
    }
  }

  // ── Microphone recording ──────────────────────────────────────────────────

  async startRecording() {
    try {
      this.interrupt();
      this.#initAudioContext();

      this.#recordingStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000,
                 echoCancellation: true, noiseSuppression: true },
      });

      this.#recAudioCtx   = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source        = this.#recAudioCtx.createMediaStreamSource(this.#recordingStream);
      this.#processorNode = this.#recAudioCtx.createScriptProcessor(2048, 1, 1);

      this.#processorNode.onaudioprocess = (e) => {
        if (!this.isConnected) return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Float32 → Int16 PCM
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Int16 → Base64
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const base64Audio = btoa(binary);

        try {
          this.#ws.send(JSON.stringify({
            realtimeInput: {
              audio: {
                data: base64Audio,
                mimeType: 'audio/pcm;rate=16000',
              }
            },
          }));
        } catch {}
      };

      source.connect(this.#processorNode);
      this.#processorNode.connect(this.#recAudioCtx.destination);
      this.#onStateChange?.('listening');

    } catch (err) {
      console.error('[LiveSession] Mic error:', err);
      this.#onError?.('mic', 'Microphone access denied or unavailable.');
    }
  }

  stopRecording() {
    try { this.#processorNode?.disconnect(); } catch {}
    this.#processorNode = null;

    this.#recordingStream?.getTracks().forEach(t => t.stop());
    this.#recordingStream = null;

    try { this.#recAudioCtx?.close(); } catch {}
    this.#recAudioCtx = null;

    if (this.#activeSources.length === 0) this.#onStateChange?.('idle');
  }

  // ── Text & Image input ────────────────────────────────────────────────────

  sendText(text) {
    if (!text?.trim() || !this.isConnected) return false;
    this.interrupt();
    this.#textBuffer = '';
    this.#onStateChange?.('thinking');
    try {
      this.#ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: text.trim() }] }],
          turnComplete: true,
        },
      }));
      return true;
    } catch (err) {
      console.warn('[LiveSession] sendText error:', err);
      return false;
    }
  }

  sendImage(base64Data, mimeType = 'image/jpeg') {
    if (!base64Data || !this.isConnected) return false;
    this.interrupt();
    this.#onStateChange?.('thinking');
    try {
      this.#ws.send(JSON.stringify({
        realtimeInput: {
          image: { data: base64Data, mimeType }
        },
      }));
      return true;
    } catch (err) {
      console.warn('[LiveSession] sendImage error:', err);
      return false;
    }
  }

  // ── Interrupt playback (barge-in) ─────────────────────────────────────────

  interrupt() {
    this.#activeSources.forEach(s => { try { s.stop(); } catch {} });
    this.#activeSources = [];
    this.#nextPlayTime  = 0;
    this.#textBuffer    = '';
  }

  // ── Handle server messages ────────────────────────────────────────────────

  #handleMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.error) {
      console.warn('[LiveSession] Server error:', data.error);
      this.#onError?.('live-api', data.error.message ?? 'Live API error.');
      return;
    }

    // setupComplete — session ready
    if (data.setupComplete) {
      console.log('[LiveSession] Setup complete — session ready.');
      return;
    }

    const sc = data.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this.interrupt();
      return;
    }

    if (sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        // Accumulate text parts
        if (part.text) {
          this.#textBuffer += part.text;
          this.#onStateChange?.('speaking');
        }
        // Play audio parts
        if (part.inlineData?.data) {
          this.#playAudioChunk(part.inlineData.data);
        }
      }
    }

    if (sc.turnComplete) {
      const fullText = this.#textBuffer.trim();

      if (fullText) {
        // Text was returned — deliver to UI
        this.#onTranscript?.('ai', fullText);
        this.#textBuffer = '';
      } else if (this.#activeSources.length > 0 || this.#nextPlayTime > 0) {
        // Audio-only response — notify UI that AI responded (audio is playing)
        // Send a short placeholder transcript so UI exits 'thinking' and shows activity
        this.#onTranscript?.('ai', '🔊'); // audio-only marker
      } else {
        // No text, no audio — something went wrong, reset to idle
        this.#onStateChange?.('idle');
      }

      console.log('[LiveSession] Turn complete. Text:', fullText?.slice(0, 60) || '(audio only)');
    }
  }

  // ── Audio playback ────────────────────────────────────────────────────────

  #playAudioChunk(base64Pcm) {
    this.#initAudioContext();
    this.#onStateChange?.('speaking');

    const binary = atob(base64Pcm);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16  = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const buffer = this.#audioCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.#audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#analyser);

    const now      = this.#audioCtx.currentTime;
    const playAt   = Math.max(now, this.#nextPlayTime);
    source.start(playAt);
    this.#nextPlayTime = playAt + buffer.duration;
    this.#activeSources.push(source);

    this.#measureAmplitude();

    source.onended = () => {
      this.#activeSources = this.#activeSources.filter(s => s !== source);
      if (this.#activeSources.length === 0 &&
          this.#audioCtx.currentTime >= this.#nextPlayTime - 0.05) {
        this.#onStateChange?.('idle');
      }
    };
  }

  #measureAmplitude() {
    if (!this.#analyser || this.#activeSources.length === 0) return;
    const data = new Uint8Array(this.#analyser.frequencyBinCount);
    this.#analyser.getByteFrequencyData(data);
    const avg  = data.reduce((s, v) => s + v, 0) / data.length;
    this.#orb?.setConversationState('speaking', Math.min(1.0, avg / 128.0));
    if (this.#activeSources.length > 0) requestAnimationFrame(() => this.#measureAmplitude());
  }

  // ── Close session ─────────────────────────────────────────────────────────

  close() {
    this.#intentionallyClosed = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopKeepAlive();
    this.stopRecording();
    this.interrupt();
    try { this.#ws?.close(); } catch {}
    this.#ws = null;
    try { this.#audioCtx?.close(); } catch {}
    this.#audioCtx = null;
    this.#onStateChange?.('idle');
  }
}
