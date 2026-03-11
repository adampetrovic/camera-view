// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULTS = {
    go2rtcUrl: '',                  // auto-detected if empty
    streams: ['zoey_hq', 'eliza_hq'],
    viewMode: 'split',              // split | single
    activeStream: 0,                // for single mode
    audioMode: 'auto',              // auto | left | right | mute
    crySensitivity: 2.5,            // ratio above baseline
    calmTimeout: 30,                // seconds
    baselineTime: 120,              // seconds for EMA adaptation
};

const AUDIO_SAMPLE_INTERVAL = 250;  // ms between audio checks
const WATCHDOG_INTERVAL = 5000;     // ms between connection health checks
const STALE_FRAME_THRESHOLD = 15000;// ms with no new frame → reconnect
const FORCE_RECONNECT_MS = 2 * 60 * 60 * 1000; // 2 hours
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;
const TOOLBAR_HIDE_DELAY = 4000;
const SUSTAIN_TIME = 1500;          // ms of elevated audio to confirm cry

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatStreamName(name) {
    return name.replace(/_/g, ' ').replace(/\b(hq|lq)\b/gi, m => m.toUpperCase());
}

function getDefaultGo2rtcUrl() {
    const domain = location.hostname.replace(/^[^.]+\./, '');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//go2rtc.${domain}`;
}

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('camera-view-settings'));
        return { ...DEFAULTS, ...saved };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveSettings(settings) {
    localStorage.setItem('camera-view-settings', JSON.stringify(settings));
}

// ─── CameraStream ────────────────────────────────────────────────────────────
// Manages a single WebRTC connection to a go2rtc stream via WebSocket.

class CameraStream {
    constructor(index) {
        this.index = index;
        this.streamName = '';
        this.ws = null;
        this.pc = null;
        this.mediaStream = null;
        this.video = null;
        this.state = 'disconnected';        // disconnected | connecting | connected
        this.reconnectTimer = null;
        this.reconnectDelay = RECONNECT_BASE_DELAY;
        this.watchdogTimer = null;
        this.forceReconnectTimer = null;
        this.lastFrameTime = 0;
        this.frameCallbackId = null;
        this.go2rtcUrl = '';

        this._onStateChange = null;
        this._onMediaStream = null;
        this._createVideo();
    }

    set onStateChange(fn) { this._onStateChange = fn; }
    set onMediaStream(fn) { this._onMediaStream = fn; }

    _createVideo() {
        this.video = document.createElement('video');
        this.video.playsInline = true;
        this.video.autoplay = true;
        this.video.muted = true;
        this.video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#000;';
    }

    _setState(s) {
        if (this.state === s) return;
        this.state = s;
        this._onStateChange?.(this.index, s);
    }

    // ── Connect ──────────────────────────────────────────────────────────────

    connect(go2rtcUrl, streamName) {
        this.disconnect();
        this.go2rtcUrl = go2rtcUrl;
        this.streamName = streamName;
        this.reconnectDelay = RECONNECT_BASE_DELAY;
        this._doConnect();
        this._startWatchdog();
        this._startForceReconnect();
    }

    _doConnect() {
        this._setState('connecting');

        const wsProto = this.go2rtcUrl.startsWith('wss:') ? 'wss:' : 'ws:';
        const host = this.go2rtcUrl.replace(/^wss?:\/\//, '');
        const wsUrl = `${wsProto}//${host}/api/ws?src=${encodeURIComponent(this.streamName)}`;

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => this._onWsOpen();
            this.ws.onclose = () => this._onWsClose();
            this.ws.onerror = (e) => console.warn(`[Stream ${this.index}] WS error`, e);
            this.ws.onmessage = (e) => this._onWsMessage(e);
        } catch (e) {
            console.error(`[Stream ${this.index}] WS connect failed`, e);
            this._scheduleReconnect();
        }
    }

    _onWsOpen() {
        console.log(`[Stream ${this.index}] WS open, starting WebRTC`);

        const pc = new RTCPeerConnection({
            bundlePolicy: 'max-bundle',
            iceServers: [
                { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
            ],
        });

        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.onicecandidate = (ev) => {
            const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
            this._wsSend({ type: 'webrtc/candidate', value: candidate });
        };

        pc.onconnectionstatechange = () => {
            console.log(`[Stream ${this.index}] PC state: ${pc.connectionState}`);
            if (pc.connectionState === 'connected') {
                this._setState('connected');
                this.reconnectDelay = RECONNECT_BASE_DELAY;
                this.lastFrameTime = Date.now();
                this._startFrameWatchdog();
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                console.warn(`[Stream ${this.index}] PC ${pc.connectionState}, reconnecting`);
                this._teardownPC();
                this._scheduleReconnect();
            }
        };

        pc.ontrack = (ev) => {
            console.log(`[Stream ${this.index}] Track: ${ev.track.kind}`);
            if (!this.mediaStream) {
                this.mediaStream = new MediaStream();
            }
            this.mediaStream.addTrack(ev.track);
            this.video.srcObject = this.mediaStream;
            this.video.play().catch(() => {});
            this._onMediaStream?.(this.index, this.mediaStream);
        };

        pc.createOffer().then(offer => {
            pc.setLocalDescription(offer);
            this._wsSend({ type: 'webrtc/offer', value: offer.sdp });
        });

        this.pc = pc;
    }

    _onWsMessage(ev) {
        if (typeof ev.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        switch (msg.type) {
            case 'webrtc/answer':
                this.pc?.setRemoteDescription({ type: 'answer', sdp: msg.value }).catch(e =>
                    console.warn(`[Stream ${this.index}] SDP answer error`, e)
                );
                break;
            case 'webrtc/candidate':
                if (msg.value) {
                    this.pc?.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(e =>
                        console.warn(`[Stream ${this.index}] ICE error`, e)
                    );
                }
                break;
            case 'error':
                console.error(`[Stream ${this.index}] go2rtc error:`, msg.value);
                break;
        }
    }

    _onWsClose() {
        console.log(`[Stream ${this.index}] WS closed`);
        this.ws = null;
        if (this.state !== 'disconnected') {
            this._scheduleReconnect();
        }
    }

    _wsSend(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    // ── Disconnect & Reconnect ───────────────────────────────────────────────

    disconnect() {
        this._setState('disconnected');
        this._stopWatchdog();
        this._stopForceReconnect();
        this._stopFrameWatchdog();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this._teardownWS();
        this._teardownPC();
        this.mediaStream = null;
        this.video.srcObject = null;
    }

    _teardownWS() {
        if (this.ws) {
            this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
            this.ws.close();
            this.ws = null;
        }
    }

    _teardownPC() {
        if (this.pc) {
            this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ontrack = null;
            this.pc.close();
            this.pc = null;
        }
    }

    _scheduleReconnect() {
        if (this.state === 'disconnected') return;
        this._teardownWS();
        this._teardownPC();
        this.mediaStream = null;
        this._setState('connecting');

        clearTimeout(this.reconnectTimer);
        console.log(`[Stream ${this.index}] Reconnecting in ${this.reconnectDelay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._doConnect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, RECONNECT_MAX_DELAY);
    }

    // ── Watchdogs ────────────────────────────────────────────────────────────

    _startWatchdog() {
        this._stopWatchdog();
        this.watchdogTimer = setInterval(() => {
            if (this.state === 'connected') {
                const elapsed = Date.now() - this.lastFrameTime;
                if (elapsed > STALE_FRAME_THRESHOLD) {
                    console.warn(`[Stream ${this.index}] Stale for ${elapsed}ms, reconnecting`);
                    this._scheduleReconnect();
                }
            }
        }, WATCHDOG_INTERVAL);
    }

    _stopWatchdog() {
        clearInterval(this.watchdogTimer);
        this.watchdogTimer = null;
    }

    _startFrameWatchdog() {
        this._stopFrameWatchdog();
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            const tick = () => {
                this.lastFrameTime = Date.now();
                if (this.state === 'connected') {
                    this.frameCallbackId = this.video.requestVideoFrameCallback(tick);
                }
            };
            this.frameCallbackId = this.video.requestVideoFrameCallback(tick);
        }
    }

    _stopFrameWatchdog() {
        if (this.frameCallbackId != null && 'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
            this.video.cancelVideoFrameCallback(this.frameCallbackId);
        }
        this.frameCallbackId = null;
    }

    _startForceReconnect() {
        this._stopForceReconnect();
        this.forceReconnectTimer = setInterval(() => {
            console.log(`[Stream ${this.index}] Periodic forced reconnect`);
            const name = this.streamName;
            const url = this.go2rtcUrl;
            this.disconnect();
            this.connect(url, name);
        }, FORCE_RECONNECT_MS);
    }

    _stopForceReconnect() {
        clearInterval(this.forceReconnectTimer);
        this.forceReconnectTimer = null;
    }
}

// ─── CryDetector ─────────────────────────────────────────────────────────────
// Per-stream state machine that detects elevated sound above a rolling baseline.
// Handles constant white noise by adapting the baseline over time.

class CryDetector {
    // States: CALM → DETECTING → CRYING → RECOVERING → CALM
    static CALM = 0;
    static DETECTING = 1;
    static CRYING = 2;
    static RECOVERING = 3;

    constructor(index, settings) {
        this.index = index;
        this.state = CryDetector.CALM;
        this.baseline = 0;
        this.currentRMS = 0;
        this.ratio = 0;
        this.detectStartTime = 0;
        this.calmStartTime = 0;
        this.baselineInitialized = false;

        this.updateSettings(settings);
    }

    updateSettings(settings) {
        this.cryThreshold = settings.crySensitivity;
        this.calmThreshold = settings.crySensitivity * 0.55;
        this.calmTimeout = settings.calmTimeout * 1000;
        // EMA alpha: we sample every AUDIO_SAMPLE_INTERVAL ms.
        // Time constant = baselineTime seconds → alpha = interval / (timeConstant * 1000)
        this.baselineAlpha = AUDIO_SAMPLE_INTERVAL / (settings.baselineTime * 1000);
    }

    update(rms) {
        this.currentRMS = rms;

        // Update baseline only when calm (don't let crying inflate it)
        if (this.state === CryDetector.CALM || this.state === CryDetector.DETECTING) {
            if (!this.baselineInitialized) {
                this.baseline = rms;
                this.baselineInitialized = true;
            } else {
                this.baseline = this.baseline * (1 - this.baselineAlpha) + rms * this.baselineAlpha;
            }
        }

        this.ratio = this.baseline > 0.001 ? rms / this.baseline : 0;

        const now = Date.now();
        let event = null;

        switch (this.state) {
            case CryDetector.CALM:
                if (this.ratio > this.cryThreshold) {
                    this.state = CryDetector.DETECTING;
                    this.detectStartTime = now;
                }
                break;

            case CryDetector.DETECTING:
                if (this.ratio < this.cryThreshold) {
                    this.state = CryDetector.CALM;
                } else if (now - this.detectStartTime > SUSTAIN_TIME) {
                    this.state = CryDetector.CRYING;
                    event = 'cry-start';
                }
                break;

            case CryDetector.CRYING:
                if (this.ratio < this.calmThreshold) {
                    this.state = CryDetector.RECOVERING;
                    this.calmStartTime = now;
                }
                break;

            case CryDetector.RECOVERING:
                if (this.ratio > this.cryThreshold) {
                    this.state = CryDetector.CRYING;
                } else if (now - this.calmStartTime > this.calmTimeout) {
                    this.state = CryDetector.CALM;
                    event = 'cry-stop';
                }
                break;
        }

        return event;
    }
}

// ─── AudioMonitor ────────────────────────────────────────────────────────────
// Analyzes audio levels from both streams using Web Audio API AnalyserNodes.

class AudioMonitor {
    constructor(settings) {
        this.ctx = null;
        this.analysers = [null, null];
        this.sources = [null, null];
        this.detectors = [
            new CryDetector(0, settings),
            new CryDetector(1, settings),
        ];
        this.levels = [0, 0];
        this.timer = null;
        this.onLevelUpdate = null;     // (index, rms, baseline, ratio) => {}
        this.onCryEvent = null;        // (index, event) => {}  event: 'cry-start' | 'cry-stop'
    }

    async init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    attachStream(index, mediaStream) {
        if (!this.ctx) return;
        // Clean up previous
        this.sources[index]?.disconnect();
        this.sources[index] = null;
        this.analysers[index] = null;

        const audioTracks = mediaStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        try {
            const source = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
            const analyser = this.ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.3;
            source.connect(analyser);
            // Don't connect to destination — we control audio via video.muted

            this.sources[index] = source;
            this.analysers[index] = analyser;
        } catch (e) {
            console.warn(`[AudioMonitor] Failed to attach stream ${index}:`, e);
        }
    }

    start() {
        this.stop();
        this.timer = setInterval(() => this._sample(), AUDIO_SAMPLE_INTERVAL);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    _sample() {
        for (let i = 0; i < 2; i++) {
            const analyser = this.analysers[i];
            if (!analyser) {
                this.levels[i] = 0;
                continue;
            }

            const data = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(data);

            // Compute RMS (data is centered at 128)
            let sum = 0;
            for (let j = 0; j < data.length; j++) {
                const v = (data[j] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            this.levels[i] = rms;

            const detector = this.detectors[i];
            const event = detector.update(rms);

            this.onLevelUpdate?.(i, rms, detector.baseline, detector.ratio);
            if (event) {
                this.onCryEvent?.(i, event);
            }
        }
    }

    updateSettings(settings) {
        this.detectors.forEach(d => d.updateSettings(settings));
    }

    destroy() {
        this.stop();
        this.sources.forEach(s => s?.disconnect());
        this.ctx?.close();
        this.ctx = null;
    }
}

// ─── App ─────────────────────────────────────────────────────────────────────

class App {
    constructor() {
        this.settings = loadSettings();
        this.streams = [new CameraStream(0), new CameraStream(1)];
        this.audioMonitor = new AudioMonitor(this.settings);
        this.streamList = [];
        this.viewMode = this.settings.viewMode;
        this.audioMode = this.settings.audioMode;
        this.activeAudioStream = 0;
        this.alertStream = -1;              // which stream triggered alert (-1 = none)
        this.preAlertMode = 'split';        // mode to return to after alert
        this.toolbarTimer = null;
        this.started = false;

        // DOM refs
        this.dom = {
            startOverlay: document.getElementById('start-overlay'),
            startBtn: document.getElementById('start-btn'),
            app: document.getElementById('app'),
            streamsEl: document.getElementById('streams'),
            containers: [document.getElementById('stream-0'), document.getElementById('stream-1')],
            selects: [document.getElementById('stream-select-0'), document.getElementById('stream-select-1')],
            modeBtn: document.getElementById('mode-btn'),
            audioBtn: document.getElementById('audio-btn'),
            fullscreenBtn: document.getElementById('fullscreen-btn'),
            settingsBtn: document.getElementById('settings-btn'),
            settingsPanel: document.getElementById('settings-panel'),
            settingsClose: document.getElementById('settings-close'),
            settingsSave: document.getElementById('settings-save'),
            toolbar: document.getElementById('toolbar'),
            go2rtcUrlInput: document.getElementById('go2rtc-url'),
            crySensitivity: document.getElementById('cry-sensitivity'),
            calmTimeout: document.getElementById('calm-timeout'),
            baselineTime: document.getElementById('baseline-time'),
        };

        this._bindEvents();
    }

    // ── Startup ──────────────────────────────────────────────────────────────

    async start() {
        if (this.started) return;
        this.started = true;

        this.dom.startOverlay.classList.add('hidden');
        this.dom.app.classList.remove('hidden');

        // Init audio context (must be in user gesture handler)
        await this.audioMonitor.init();

        // Resolve go2rtc URL
        if (!this.settings.go2rtcUrl) {
            this.settings.go2rtcUrl = getDefaultGo2rtcUrl();
        }

        // Mount videos
        for (let i = 0; i < 2; i++) {
            const videoSlot = this.dom.containers[i].querySelector('.stream-video');
            videoSlot.appendChild(this.streams[i].video);

            this.streams[i].onStateChange = (idx, state) => this._onStreamState(idx, state);
            this.streams[i].onMediaStream = (idx, ms) => this._onMediaStream(idx, ms);
        }

        // Fetch stream list & populate selects
        await this._fetchStreamList();
        this._populateSelects();

        // Connect streams
        this._connectStreams();

        // Start audio monitoring
        this.audioMonitor.onLevelUpdate = (i, rms, baseline, ratio) => this._onAudioLevel(i, rms, baseline, ratio);
        this.audioMonitor.onCryEvent = (i, event) => this._onCryEvent(i, event);
        this.audioMonitor.start();

        // Apply initial view
        this._applyViewMode();
        this._applyAudioMode();
        this._updateModeButton();
        this._updateAudioButton();
        this._populateSettings();
        this._showToolbar();

        // Page visibility handling
        document.addEventListener('visibilitychange', () => this._onVisibilityChange());
        window.addEventListener('online', () => this._onNetworkRestore());
    }

    // ── Stream List ──────────────────────────────────────────────────────────

    async _fetchStreamList() {
        const httpUrl = this.settings.go2rtcUrl
            .replace(/^ws:/, 'http:')
            .replace(/^wss:/, 'https:');

        try {
            const resp = await fetch(`${httpUrl}/api/streams`);
            const data = await resp.json();
            this.streamList = Object.keys(data).sort();
        } catch (e) {
            console.warn('[App] Failed to fetch stream list:', e);
            // Fallback: use configured streams
            this.streamList = [...this.settings.streams];
        }
    }

    _populateSelects() {
        for (let i = 0; i < 2; i++) {
            const sel = this.dom.selects[i];
            sel.innerHTML = '';
            for (const name of this.streamList) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = formatStreamName(name);
                sel.appendChild(opt);
            }
            sel.value = this.settings.streams[i] || this.streamList[0] || '';
        }
    }

    _connectStreams() {
        for (let i = 0; i < 2; i++) {
            const name = this.dom.selects[i].value;
            this.settings.streams[i] = name;
            this.streams[i].connect(this.settings.go2rtcUrl, name);
            this._updateStreamLabel(i, name);
        }
        saveSettings(this.settings);
    }

    _updateStreamLabel(index, name) {
        const label = this.dom.containers[index].querySelector('.stream-label');
        label.textContent = formatStreamName(name);
        const debugLabel = document.getElementById(`debug-label-${index}`);
        if (debugLabel) debugLabel.textContent = formatStreamName(name);
    }

    // ── Stream Events ────────────────────────────────────────────────────────

    _onStreamState(index, state) {
        const icon = this.dom.containers[index].querySelector('.status-icon');
        switch (state) {
            case 'disconnected': icon.textContent = '⏹'; break;
            case 'connecting':   icon.textContent = '⏳'; break;
            case 'connected':    icon.textContent = '🟢'; break;
        }
    }

    _onMediaStream(index, mediaStream) {
        this.audioMonitor.attachStream(index, mediaStream);
    }

    // ── Audio Events ─────────────────────────────────────────────────────────

    _onAudioLevel(index, rms, baseline, ratio) {
        // Update meter
        const fill = this.dom.containers[index].querySelector('.audio-meter-fill');
        const pct = Math.min(rms * 500, 100); // Scale for visibility
        fill.style.width = `${pct}%`;
        fill.classList.toggle('loud', ratio > this.settings.crySensitivity);

        // Update debug
        const debugFill = document.getElementById(`debug-rms-${index}`);
        const debugValue = document.getElementById(`debug-value-${index}`);
        const debugBaseline = document.getElementById(`debug-baseline-${index}`);
        if (debugFill) debugFill.style.width = `${pct}%`;
        if (debugValue) debugValue.textContent = rms.toFixed(3);
        if (debugBaseline) debugBaseline.textContent = `base: ${baseline.toFixed(3)}`;
    }

    _onCryEvent(index, event) {
        console.log(`[App] Cry event: stream ${index} → ${event}`);

        if (event === 'cry-start') {
            // Switch audio to crying stream
            this.activeAudioStream = index;
            this._applyAudioRouting();

            // Enter alert view
            if (this.alertStream === -1) {
                this.preAlertMode = this.viewMode;
            }
            this.alertStream = index;
            this._applyAlertView(index);

            this.dom.containers[index].classList.add('alert-active');
        } else if (event === 'cry-stop') {
            this.dom.containers[index].classList.remove('alert-active');

            // Only exit alert if this was the alerting stream
            if (this.alertStream === index) {
                this.alertStream = -1;
                // Check if the OTHER stream is still crying
                const other = 1 - index;
                const otherDetector = this.audioMonitor.detectors[other];
                if (otherDetector.state === CryDetector.CRYING || otherDetector.state === CryDetector.RECOVERING) {
                    this.alertStream = other;
                    this._applyAlertView(other);
                } else {
                    this._exitAlertView();
                }
            }
        }
    }

    // ── View Modes ───────────────────────────────────────────────────────────

    _applyViewMode() {
        const el = this.dom.streamsEl;
        el.className = '';

        if (this.alertStream >= 0) {
            this._applyAlertView(this.alertStream);
            return;
        }

        el.classList.add(`mode-${this.viewMode}`);

        for (let i = 0; i < 2; i++) {
            const c = this.dom.containers[i];
            c.classList.remove('alert-main', 'alert-pip', 'inactive');
            if (this.viewMode === 'single' && i !== this.activeStream) {
                c.classList.add('inactive');
            }
        }
    }

    _applyAlertView(alertIndex) {
        const el = this.dom.streamsEl;
        el.className = 'mode-alert';

        for (let i = 0; i < 2; i++) {
            const c = this.dom.containers[i];
            c.classList.remove('alert-main', 'alert-pip', 'inactive');
            if (i === alertIndex) {
                c.classList.add('alert-main');
            } else {
                c.classList.add('alert-pip');
            }
        }
    }

    _exitAlertView() {
        this.alertStream = -1;
        this.viewMode = this.preAlertMode;
        this._applyViewMode();
        this._updateModeButton();
    }

    _cycleViewMode() {
        if (this.alertStream >= 0) {
            // Force exit alert
            this.dom.containers[this.alertStream].classList.remove('alert-active');
            this.alertStream = -1;
        }

        if (this.viewMode === 'split') {
            this.viewMode = 'single';
            this.activeStream = 0;
        } else if (this.viewMode === 'single' && this.activeStream === 0) {
            this.activeStream = 1;
        } else {
            this.viewMode = 'split';
        }

        this.settings.viewMode = this.viewMode;
        this.settings.activeStream = this.activeStream;
        saveSettings(this.settings);
        this._applyViewMode();
        this._updateModeButton();
    }

    get activeStream() { return this.settings.activeStream; }
    set activeStream(v) { this.settings.activeStream = v; }

    _updateModeButton() {
        const icon = this.dom.modeBtn.querySelector('.mode-icon');
        const label = this.dom.modeBtn.querySelector('.mode-label');
        if (this.viewMode === 'split') {
            icon.textContent = '◫';
            label.textContent = 'Split';
        } else {
            icon.textContent = '◻';
            label.textContent = `Single: ${formatStreamName(this.settings.streams[this.activeStream] || '')}`;
        }
    }

    // ── Audio Mode ───────────────────────────────────────────────────────────

    _applyAudioMode() {
        this._applyAudioRouting();
    }

    _applyAudioRouting() {
        for (let i = 0; i < 2; i++) {
            let shouldPlay = false;
            switch (this.audioMode) {
                case 'auto':
                    shouldPlay = (i === this.activeAudioStream);
                    break;
                case 'left':
                    shouldPlay = (i === 0);
                    break;
                case 'right':
                    shouldPlay = (i === 1);
                    break;
                case 'mute':
                    shouldPlay = false;
                    break;
            }
            this.streams[i].video.muted = !shouldPlay;
            this.dom.containers[i].classList.toggle('audio-active', shouldPlay);
        }
    }

    _cycleAudioMode() {
        const modes = ['auto', 'left', 'right', 'mute'];
        const idx = modes.indexOf(this.audioMode);
        this.audioMode = modes[(idx + 1) % modes.length];
        this.settings.audioMode = this.audioMode;
        saveSettings(this.settings);
        this._applyAudioMode();
        this._updateAudioButton();
    }

    _updateAudioButton() {
        const icon = this.dom.audioBtn.querySelector('.audio-icon');
        const label = this.dom.audioBtn.querySelector('.audio-label');
        switch (this.audioMode) {
            case 'auto':  icon.textContent = '🔊'; label.textContent = 'Auto'; break;
            case 'left':  icon.textContent = '◀🔊'; label.textContent = 'Left'; break;
            case 'right': icon.textContent = '🔊▶'; label.textContent = 'Right'; break;
            case 'mute':  icon.textContent = '🔇'; label.textContent = 'Mute'; break;
        }
    }

    // ── Toolbar ──────────────────────────────────────────────────────────────

    _showToolbar() {
        this.dom.toolbar.classList.remove('hidden-toolbar');
        document.body.classList.remove('toolbar-hidden');
        this._resetToolbarTimer();
    }

    _hideToolbar() {
        this.dom.toolbar.classList.add('hidden-toolbar');
        document.body.classList.add('toolbar-hidden');
    }

    _toggleToolbar() {
        if (this.dom.toolbar.classList.contains('hidden-toolbar')) {
            this._showToolbar();
        } else {
            this._hideToolbar();
        }
    }

    _resetToolbarTimer() {
        clearTimeout(this.toolbarTimer);
        this.toolbarTimer = setTimeout(() => this._hideToolbar(), TOOLBAR_HIDE_DELAY);
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    _populateSettings() {
        this.dom.go2rtcUrlInput.value = this.settings.go2rtcUrl;
        this.dom.crySensitivity.value = this.settings.crySensitivity;
        this.dom.calmTimeout.value = this.settings.calmTimeout;
        this.dom.baselineTime.value = this.settings.baselineTime;
    }

    _saveSettings() {
        this.settings.go2rtcUrl = this.dom.go2rtcUrlInput.value || getDefaultGo2rtcUrl();
        this.settings.crySensitivity = parseFloat(this.dom.crySensitivity.value);
        this.settings.calmTimeout = parseInt(this.dom.calmTimeout.value);
        this.settings.baselineTime = parseInt(this.dom.baselineTime.value);
        saveSettings(this.settings);

        this.audioMonitor.updateSettings(this.settings);
        this.dom.settingsPanel.classList.add('hidden');

        // Reconnect with new settings
        this._connectStreams();
    }

    // ── Fullscreen ───────────────────────────────────────────────────────────

    _toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    }

    // ── Resilience ───────────────────────────────────────────────────────────

    _onVisibilityChange() {
        if (document.hidden) {
            // Page hidden — pause audio analysis to save CPU
            this.audioMonitor.stop();
        } else {
            // Page visible — resume and health-check connections
            this.audioMonitor.start();
            for (let i = 0; i < 2; i++) {
                if (this.streams[i].state !== 'connected') {
                    console.log(`[App] Visibility restored, stream ${i} not connected, reconnecting`);
                    this.streams[i].connect(this.settings.go2rtcUrl, this.settings.streams[i]);
                }
            }
        }
    }

    _onNetworkRestore() {
        console.log('[App] Network restored, reconnecting all streams');
        setTimeout(() => this._connectStreams(), 1000);
    }

    // ── Events ───────────────────────────────────────────────────────────────

    _bindEvents() {
        // Start
        this.dom.startBtn.addEventListener('click', () => this.start());

        // Toolbar interaction keeps it visible
        this.dom.toolbar.addEventListener('pointerdown', () => this._resetToolbarTimer());

        // Tap streams area to toggle toolbar
        this.dom.streamsEl.addEventListener('click', (e) => {
            if (e.target.closest('.stream-select, .toolbar-btn, #settings-panel')) return;
            this._toggleToolbar();
        });

        // Stream selectors
        for (let i = 0; i < 2; i++) {
            this.dom.selects[i].addEventListener('change', () => {
                const name = this.dom.selects[i].value;
                this.settings.streams[i] = name;
                saveSettings(this.settings);
                this.streams[i].connect(this.settings.go2rtcUrl, name);
                this._updateStreamLabel(i, name);
                this._updateModeButton();
                this._resetToolbarTimer();
            });
        }

        // Mode button
        this.dom.modeBtn.addEventListener('click', () => {
            this._cycleViewMode();
            this._resetToolbarTimer();
        });

        // Audio button
        this.dom.audioBtn.addEventListener('click', () => {
            this._cycleAudioMode();
            this._resetToolbarTimer();
        });

        // Fullscreen
        this.dom.fullscreenBtn.addEventListener('click', () => {
            this._toggleFullscreen();
            this._resetToolbarTimer();
        });

        // Settings
        this.dom.settingsBtn.addEventListener('click', () => {
            this.dom.settingsPanel.classList.toggle('hidden');
            this._populateSettings();
            this._resetToolbarTimer();
        });
        this.dom.settingsClose.addEventListener('click', () => {
            this.dom.settingsPanel.classList.add('hidden');
        });
        this.dom.settingsSave.addEventListener('click', () => {
            this._saveSettings();
        });

        // Close settings on backdrop click
        this.dom.settingsPanel.addEventListener('click', (e) => {
            if (e.target === this.dom.settingsPanel) {
                this.dom.settingsPanel.classList.add('hidden');
            }
        });

        // Settings sliders show live values
        this.dom.crySensitivity.addEventListener('input', (e) => {
            e.target.closest('.settings-group').querySelector('small').textContent =
                `Ratio above baseline to trigger alert (${parseFloat(e.target.value).toFixed(1)}×). Lower = more sensitive.`;
        });
        this.dom.calmTimeout.addEventListener('input', (e) => {
            e.target.closest('.settings-group').querySelector('small').textContent =
                `How long to wait after sound stops (${e.target.value}s).`;
        });
        this.dom.baselineTime.addEventListener('input', (e) => {
            e.target.closest('.settings-group').querySelector('small').textContent =
                `Time for audio baseline to adapt (${e.target.value}s).`;
        });
    }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const app = new App();
