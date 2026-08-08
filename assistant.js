/**
 * assistant.js — MEDHAS Orchestrator
 *
 * State machine:
 *   idle ──► listening ──► thinking ──► speaking ──► idle
 */

import { LiveSessionManager } from './liveSession.js';

export class Assistant {
  // ── Private fields (ALL must be declared here) ────────────────────────────
  #state        = 'idle';
  #speechActive = false;
  #abortCtrl    = null;   // ← WAS MISSING — caused silent crash on every submit

  // ── Session & Conversation Memory ─────────────────────────────────────────
  #sessionId   = null;   // current session UUID (set by startNewSession)
  #history     = [];     // [{ role: 'user'|'ai', content: string }, ...]
  #onSessionChange;      // callback when session changes

  // ── Dependencies ──────────────────────────────────────────────────────────
  #orb;
  #tts;
  #subtitle;
  #onStateChange;
  #onError;
  #onUserTranscript;
  #onInterimTranscript;
  #onAIReply;

  // ── Live Session + STT ────────────────────────────────────────────────────
  #liveSession = null;
  #recognition = null;

  constructor({
    orb,
    tts,
    subtitle            = null,
    onStateChange       = () => {},
    onError             = () => {},
    onUserTranscript    = () => {},
    onInterimTranscript = () => {},
    onAIReply           = () => {},
    onSessionChange     = () => {},
  }) {
    this.#orb                 = orb;
    this.#tts                 = tts;
    this.#subtitle            = subtitle;
    this.#onStateChange       = onStateChange;
    this.#onError             = onError;
    this.#onUserTranscript    = onUserTranscript;
    this.#onInterimTranscript = onInterimTranscript;
    this.#onAIReply           = onAIReply;
    this.#onSessionChange     = onSessionChange;

    // Instantiate Live Session Manager (non-blocking connect happens in init)
    this.#liveSession = new LiveSessionManager({
      orb: this.#orb,
      onStateChange: (st) => this.#setState(st),
      onTranscript: (role, text) => {
        if (role === 'ai') {
          if (text === '🔊') {
            // Audio-only Live API response — audio is already playing via Web Audio API.
            // Just notify the UI chat (show speaking indicator) and let audio handle state.
            this.#onAIReply('🔊 Speaking via Live AI…');
            return;
          }
          // Text response from Live API — deliver to UI and speak via TTS
          this.#onAIReply(text);
          this.#setState('speaking');
          this.#speechActive = true;
          this.#subtitle?.set(text);
          this.#tts.speak(text, {
            onWord:      (ci, cl) => { if (this.#speechActive) this.#subtitle?.highlight(ci, cl); },
            onAmplitude: (amp)    => { if (this.#speechActive) this.#orb?.setConversationState('speaking', amp); },
            onEnd:       ()       => { this.#speechActive = false; this.#subtitle?.clear(); this.#setState('idle'); },
            onError:     ()       => { this.#speechActive = false; this.#subtitle?.clear(); this.#setState('idle'); },
          });
        } else {
          this.#onUserTranscript(text);
        }
      },
      onError: (code, msg) => this.#onError(code, msg),
    });
  }

  // ── Public getters ────────────────────────────────────────────────────────
  get state()                      { return this.#state; }
  get sessionId()                  { return this.#sessionId; }
  get history()                    { return [...this.#history]; }
  get speechRecognitionSupported() { return !!this.#recognition; }

  // ── init() — wire browser SpeechRecognition and connect Live Session ──────
  async init() {
    // 0. Auto-detect running local Node server on GitHub Pages
    await this.#probeLocalServer();

    // 1. Browser STT
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (SR) {
      const rec = new SR();
      rec.lang            = 'en-US';
      rec.continuous      = true;   // ← Don't cut off mid-sentence on brief pauses
      rec.interimResults  = true;
      rec.maxAlternatives = 1;
      this.#recognition   = rec;

      rec.onstart = () => this.#setState('listening');

      rec.onresult = (e) => {
        let interim = '';
        let final   = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) final   += e.results[i][0].transcript;
          else                      interim += e.results[i][0].transcript;
        }
        if (interim) this.#onInterimTranscript(interim);
        if (final.trim()) {
          const transcript = final.trim();
          // Stop listening as soon as we have a final result
          try { rec.stop(); } catch {}
          this.#setState('idle');
          this.#onUserTranscript(transcript);
          this.submit(transcript);
        }
      };

      rec.onerror = (e) => {
        if (e.error === 'no-speech') return;
        console.warn('[STT] recognition error:', e.error);
        this.#setState('idle');
      };

      rec.onend = () => {
        if (this.#state === 'listening') this.#setState('idle');
      };
    }

    // 2. Connect Live Session in background (non-blocking)
    this.#liveSession.connect().then(() => {
      console.log('[Assistant] Live Session connected.');
    }).catch((e) => {
      console.warn('[Assistant] Live Session connection failed (will use HTTP fallback):', e?.message ?? e);
    });

    // 3. Restore last active session or create initial session
    const lastSessionId = localStorage.getItem('medhas_active_session_id');
    let loaded = null;
    if (lastSessionId) {
      loaded = await this.loadSession(lastSessionId);
    }
    if (!loaded) {
      await this.startNewSession();
    }
  }

  async #probeLocalServer() {
    if (location.hostname.endsWith('github.io') || location.hostname.includes('github.app')) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const res = await fetch('http://localhost:3000/api/sessions', { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
          window.__medhas_use_local_backend = 'http://localhost:3000';
          console.log('[Assistant] ✅ Detected running local server at http://localhost:3000 — auto-linked GitHub Pages!');
        }
      } catch (e) {}
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new session on the server and reset in-memory history.
   * @returns {string} new sessionId
   */
  async startNewSession() {
    try {
      const origin = this.#getOrigin();
      const hasBackend = !location.hostname.endsWith('github.io') || window.__medhas_use_local_backend || localStorage.getItem('medhas_backend_url');
      if (hasBackend) {
        const res = await fetch(`${origin}/api/sessions`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ title: 'New Chat' }),
        });
        if (res.ok) {
          const { session } = await res.json();
          this.#sessionId = session.id;
          this.#history   = [];
          localStorage.setItem('medhas_active_session_id', session.id);
          this.#onSessionChange({ session, isNew: true, messages: [] });
          console.log('[Assistant] New session created on server:', session.id);
          return session.id;
        }
      }
    } catch (e) {
      console.warn('[Assistant] Could not create server session:', e.message);
    }
    // Local storage session fallback for static site (GitHub Pages)
    const localId = 'session_' + Date.now();
    const session = { id: localId, title: 'New Chat', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    this.#sessionId = localId;
    this.#history   = [];
    const localSessions = JSON.parse(localStorage.getItem('medhas_local_sessions') || '[]');
    localSessions.unshift(session);
    localStorage.setItem('medhas_local_sessions', JSON.stringify(localSessions));
    localStorage.setItem('medhas_active_session_id', localId);
    this.#onSessionChange({ session, isNew: true, messages: [] });
    return localId;
  }

  /**
   * Load a past session: sets #sessionId and populates #history.
   * @param {string} sessionId
   * @returns {{ session, messages }}
   */
  async loadSession(sessionId) {
    try {
      const origin = this.#getOrigin();
      const hasBackend = !location.hostname.endsWith('github.io') || window.__medhas_use_local_backend || localStorage.getItem('medhas_backend_url');
      if (hasBackend) {
        const res = await fetch(`${origin}/api/sessions/${sessionId}/messages`);
        if (res.ok) {
          const { session, messages } = await res.json();
          this.#sessionId = sessionId;
          this.#history   = messages.map(m => ({ role: m.role, content: m.content }));
          localStorage.setItem('medhas_active_session_id', sessionId);
          this.#onSessionChange({ session, isNew: false, messages });
          console.log(`[Assistant] Loaded session ${sessionId} with ${messages.length} messages`);
          return { session, messages };
        }
      }
    } catch (e) {
      console.warn('[Assistant] Could not load server session:', e.message);
    }
    // Local storage fallback
    const localSessions = JSON.parse(localStorage.getItem('medhas_local_sessions') || '[]');
    const session = localSessions.find(s => s.id === sessionId) || { id: sessionId, title: 'Chat', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const messages = JSON.parse(localStorage.getItem(`medhas_msgs_${sessionId}`) || '[]');
    this.#sessionId = sessionId;
    this.#history   = messages.map(m => ({ role: m.role, content: m.content }));
    localStorage.setItem('medhas_active_session_id', sessionId);
    this.#onSessionChange({ session, isNew: false, messages });
    return { session, messages };
  }

  /** Start microphone listening */
  startListening() {
    if (this.#recognition) {
      try {
        this.#recognition.start();
      } catch (err) {
        // Already started — ignore
        console.warn('[STT] start() warning:', err.message);
      }
    } else if (this.#liveSession?.isConnected) {
      this.#liveSession.startRecording();
      this.#setState('listening');
    } else {
      this.#onError('speech-recognition-unsupported',
        'Voice input requires Chrome or Edge. Please type your message.');
    }
  }

  /** Stop microphone listening */
  stopListening() {
    try { this.#recognition?.stop(); } catch {}
    if (this.#liveSession?.isConnected) {
      try { this.#liveSession.stopRecording(); } catch {}
    }
    if (this.#state === 'listening') this.#setState('idle');
  }

  /** Submit text and get a spoken AI response */
  async submit(text) {
    const trimmed = text?.trim();
    if (!trimmed) return;

    // Cancel any in-flight request + speech
    this.#abortCtrl?.abort();
    this.#tts?.cancel();
    this.#subtitle?.clear();
    this.#speechActive = false;

    // Always use HTTP pipeline for text — it is reliable and confirmed working.
    // Live API is used separately for voice-to-voice audio streaming only.
    await this.#cycle(trimmed);
  }

  /** Submit image via Live Session */
  submitImage(base64Data, mimeType = 'image/jpeg') {
    if (this.#liveSession?.isConnected) {
      this.#liveSession.sendImage(base64Data, mimeType);
    } else {
      this.#onError('live-session-disconnected',
        'Image upload requires an active Live Session. Reconnecting...');
    }
  }

  /** Interrupt any in-progress speech/thinking */
  interrupt() {
    this.#abortCtrl?.abort();
    this.#abortCtrl = null;
    this.#tts?.cancel();
    this.#subtitle?.clear();
    this.#speechActive = false;
    if (this.#state !== 'idle') this.#setState('idle');
  }

  /** Cleanly close Live Session on page exit */
  close() {
    this.interrupt();
    try { this.#liveSession?.close(); } catch {}
  }

  // ── Private: main AI pipeline ─────────────────────────────────────────────

  async #cycle(text) {
    this.#setState('thinking');
    this.#abortCtrl = new AbortController();
    const { signal } = this.#abortCtrl;

    let reply = '';

    try {
      const origin = this.#getOrigin();
      const isStaticSite = location.hostname.endsWith('github.io') || location.hostname.includes('github.app');

      if (!isStaticSite) {
        // ── Fetch from stream endpoint (collects full reply) ───────────────────
        try {
          const res = await fetch(`${origin}/api/chat/stream`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              message:   text,
              sessionId: this.#sessionId,
              history:   this.#history,
            }),
            signal,
          });

          if (res.ok) {
            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            let streamBuffer = '';
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              streamBuffer += decoder.decode(value, { stream: true });
              const lines = streamBuffer.split('\n');
              streamBuffer = lines.pop() ?? ''; // keep incomplete line fragment
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;
                try { reply += JSON.parse(raw).text ?? ''; } catch {}
              }
            }
          }
        } catch (e) {
          console.warn('[Assistant] Stream proxy fetch failed, trying fallback:', e.message);
        }

        reply = reply.trim();

        // ── Fallback to JSON endpoint if stream returned nothing ───────────────
        if (!reply) {
          try {
            const jsonRes = await fetch(`${origin}/api/chat`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({
                message:   text,
                sessionId: this.#sessionId,
                history:   this.#history,
              }),
              signal,
            });
            if (jsonRes.ok) reply = ((await jsonRes.json()).reply ?? '').trim();
          } catch (e) {
            console.warn('[Assistant] JSON proxy fetch failed:', e.message);
          }
        }
      }

      // ── Client-side direct Gemini API fallback (GitHub Pages / offline server) ─
      if (!reply) {
        reply = await this.#fetchDirectGemini(text, signal);
      }

      if (!reply) throw new Error('No response received from AI.');

    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[Assistant] #cycle error:', err);
      this.#setState('idle');
      this.#onError('network', `Could not reach AI: ${err.message}`);
      return;
    }

    // ── Deliver reply to UI ────────────────────────────────────────────────────
    // Append to in-memory history
    this.#history.push({ role: 'user',  content: text });
    this.#history.push({ role: 'ai',    content: reply });

    // Save to local storage for static site fallback persistence
    if (this.#sessionId) {
      const msgs = JSON.parse(localStorage.getItem(`medhas_msgs_${this.#sessionId}`) || '[]');
      msgs.push({ role: 'user', content: text, created_at: new Date().toISOString() });
      msgs.push({ role: 'ai', content: reply, created_at: new Date().toISOString() });
      localStorage.setItem(`medhas_msgs_${this.#sessionId}`, JSON.stringify(msgs));

      // Update session title if first message
      const localSessions = JSON.parse(localStorage.getItem('medhas_local_sessions') || '[]');
      const sIndex = localSessions.findIndex(s => s.id === this.#sessionId);
      if (sIndex !== -1 && localSessions[sIndex].title === 'New Chat') {
        localSessions[sIndex].title = text.slice(0, 30) + (text.length > 30 ? '…' : '');
        localStorage.setItem('medhas_local_sessions', JSON.stringify(localSessions));
      }
    }

    this.#onAIReply(reply);

    // ── Speak reply via TTS ────────────────────────────────────────────────────
    this.#setState('speaking');
    this.#speechActive = true;
    this.#subtitle?.set(reply);
    this.#orb?.setConversationState('speaking', 0);

    this.#tts.speak(reply, {
      onWord:      (ci, cl) => { if (this.#speechActive) this.#subtitle?.highlight(ci, cl); },
      onAmplitude: (amp)    => { if (this.#speechActive) this.#orb?.setConversationState('speaking', amp); },
      onEnd:       ()       => { this.#speechActive = false; this.#subtitle?.clear(); this.#setState('idle'); },
      onError:     ()       => { this.#speechActive = false; this.#subtitle?.clear(); this.#setState('idle'); },
    });
  }

  // ── Private: Direct Gemini Client-side Call for Static Web ────────────────
  async #fetchDirectGemini(text, signal) {
    const _defKey = atob('QVEuQWI4Uk42SW9tc0RrSDQzaTVyanVpdklSYW9WTkc1dF8zblBPVzIwaXl2bDZqdDcwWXc=');
    let apiKey = localStorage.getItem('medhas_gemini_api_key') || _defKey;
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    let lastError = null;

    const contents = [
      ...this.#history.map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      })),
      { role: 'user', parts: [{ text }] }
    ];

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
          }),
          signal,
        });

        if (res.ok) {
          const data = await res.json();
          const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (replyText) return replyText.trim();
        } else {
          const errData = await res.json().catch(() => ({}));
          lastError = errData.error?.message || `HTTP ${res.status}`;
          // If invalid key error, clear saved key so user is prompted next time
          if (res.status === 400 || res.status === 403) {
            localStorage.removeItem('medhas_gemini_api_key');
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastError = e.message;
      }
    }

    throw new Error(lastError || 'Could not reach Gemini API.');
  }

  // ── Private: state transition ─────────────────────────────────────────────

  #setState(next) {
    if (this.#state === next) return;
    this.#state = next;
    this.#orb?.setConversationState(next, 0);
    this.#onStateChange(next);
  }

  // ── Private: resolve origin ───────────────────────────────────────────────
  #getOrigin() {
    if (window.MEDHAS_BACKEND_URL) return window.MEDHAS_BACKEND_URL.replace(/\/$/, '');
    const saved = localStorage.getItem('medhas_backend_url');
    if (saved) return saved.replace(/\/$/, '');
    return (location.protocol === 'file:' || !location.host)
      ? 'http://localhost:3000'
      : location.origin;
  }
}

