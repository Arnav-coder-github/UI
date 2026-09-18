/* ============================================================
   VoiceAuto — modular auto-listen / VAD controller
   ------------------------------------------------------------
   Default OFF. When ON: local mic VAD waits for speech, only
   forwards utterances to ASR after a short silence threshold.
   Pause during TTS so speaker echo never reaches ASR.

   Pipeline-facing states (mirrors AI turn):
     idle | listening | thinking | speaking | paused

   Usage:
     const voice = VoiceAuto.create({ ...config, onEvent })
     voice.setEnabled(true)
     voice.notifyPipeline("speaking")  // pause VAD
     voice.notifyPipeline("idle")      // resume after TTS
     const action = voice.processFrame(energy, samples)
   ============================================================ */
(function (global) {
  "use strict";

  const DEFAULTS = {
    /** RMS above this = speech */
    speechThreshold: 0.025,
    /** Must hold speech this long before capture starts */
    speechHoldMs: 120,
    /** Silence after speech before utterance is complete */
    endSilenceMs: 700,
    /** Ignore mic briefly after TTS ends (echo settle) */
    ttsResumeGraceMs: 550,
    /** Pre-roll frames kept before speech lock (approx) */
    prerollFrames: 4,
  };

  function create(opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : function () {};

    let enabled = false;
    let pipeline = "idle"; // idle | listening | thinking | speaking
    let vad = "off"; // off | waiting | holding | capturing | paused
    let pausedUntil = 0;
    let speechHoldStartedAt = 0;
    let lastSpeechAt = 0;
    let preroll = [];

    function emit(type, detail) {
      onEvent({ type, detail: detail || {}, enabled, pipeline, vad });
    }

    function setVad(next) {
      if (vad === next) return;
      const prev = vad;
      vad = next;
      emit("vad", { prev, vad });
    }

    function canMonitor() {
      if (!enabled) return false;
      if (pipeline === "speaking") return false;
      if (pipeline === "thinking") return false; // wait for reply; barge-in handled separately if desired
      if (pipeline === "listening" && vad === "capturing") return true;
      if (performance.now() < pausedUntil) return false;
      return pipeline === "idle" || vad === "waiting" || vad === "holding";
    }

    function enterWaiting() {
      if (!enabled) {
        setVad("off");
        return;
      }
      if (pipeline === "speaking" || pipeline === "thinking") {
        setVad("paused");
        return;
      }
      speechHoldStartedAt = 0;
      lastSpeechAt = 0;
      preroll = [];
      setVad("waiting");
      emit("ready", {});
    }

    function setEnabled(on) {
      const next = !!on;
      if (enabled === next) return enabled;
      enabled = next;
      emit("enabled", { enabled });
      if (!enabled) {
        speechHoldStartedAt = 0;
        lastSpeechAt = 0;
        preroll = [];
        setVad("off");
        emit("stop_monitor", {});
      } else {
        enterWaiting();
        emit("start_monitor", {});
      }
      return enabled;
    }

    function notifyPipeline(state) {
      const prev = pipeline;
      pipeline = state || "idle";

      if (!enabled) {
        setVad("off");
        emit("pipeline", { prev, pipeline });
        return;
      }

      if (pipeline === "speaking") {
        // Hard pause — never feed mic to ASR while TTS plays
        speechHoldStartedAt = 0;
        lastSpeechAt = 0;
        preroll = [];
        setVad("paused");
        emit("tts_pause", {});
      } else if (pipeline === "thinking") {
        speechHoldStartedAt = 0;
        lastSpeechAt = 0;
        preroll = [];
        setVad("paused");
      } else if (pipeline === "listening") {
        // Manual or auto capture in progress
        if (vad !== "capturing") setVad("capturing");
      } else if (pipeline === "idle") {
        // After TTS / turn end — brief grace then listen again
        pausedUntil = performance.now() + opts.ttsResumeGraceMs;
        setVad("paused");
        emit("tts_resume_pending", { graceMs: opts.ttsResumeGraceMs });
        // Schedule waiting once grace elapses (caller may also poll)
      }

      emit("pipeline", { prev, pipeline });
    }

    /**
     * Call every audio frame while the mic is open.
     * @returns {{ action: string, samples?: Float32Array, flushPreroll?: Float32Array[] }}
     *   none | ignore | start_utterance | append | end_utterance
     */
    function processFrame(energy, samples) {
      if (!enabled) return { action: "none" };

      const now = performance.now();

      // Grace window after TTS
      if (vad === "paused") {
        if (pipeline === "idle" && now >= pausedUntil) {
          enterWaiting();
        } else {
          return { action: "ignore" };
        }
      }

      if (pipeline === "speaking" || pipeline === "thinking") {
        return { action: "ignore" };
      }

      // Already capturing an utterance
      if (vad === "capturing") {
        const isSpeech = energy > opts.speechThreshold;
        if (isSpeech) lastSpeechAt = now;
        if (
          lastSpeechAt > 0 &&
          now - lastSpeechAt >= opts.endSilenceMs
        ) {
          setVad("paused"); // brief hold until pipeline leaves listening
          return { action: "end_utterance", samples };
        }
        return { action: "append", samples };
      }

      if (vad !== "waiting" && vad !== "holding") {
        return { action: "none" };
      }

      // Waiting / holding for speech onset
      const isSpeech = energy > opts.speechThreshold;
      if (!isSpeech) {
        speechHoldStartedAt = 0;
        // Keep a short preroll ring buffer of near-silence frames
        preroll.push(samples ? new Float32Array(samples) : null);
        if (preroll.length > opts.prerollFrames) preroll.shift();
        if (vad === "holding") setVad("waiting");
        return { action: "ignore" };
      }

      if (!speechHoldStartedAt) {
        speechHoldStartedAt = now;
        setVad("holding");
      }

      preroll.push(samples ? new Float32Array(samples) : null);
      if (preroll.length > opts.prerollFrames + 2) preroll.shift();

      if (now - speechHoldStartedAt >= opts.speechHoldMs) {
        const flush = preroll.filter(Boolean);
        preroll = [];
        speechHoldStartedAt = 0;
        lastSpeechAt = now;
        setVad("capturing");
        emit("speech_start", {});
        return { action: "start_utterance", samples, flushPreroll: flush };
      }

      return { action: "ignore" };
    }

    function markCapturing() {
      if (enabled) setVad("capturing");
    }

    function getConfig() {
      return {
        speechThreshold: opts.speechThreshold,
        speechHoldMs: opts.speechHoldMs,
        endSilenceMs: opts.endSilenceMs,
        ttsResumeGraceMs: opts.ttsResumeGraceMs,
      };
    }

    function setConfig(partial) {
      if (!partial) return getConfig();
      if (partial.speechThreshold != null) opts.speechThreshold = +partial.speechThreshold;
      if (partial.speechHoldMs != null) opts.speechHoldMs = +partial.speechHoldMs;
      if (partial.endSilenceMs != null) opts.endSilenceMs = +partial.endSilenceMs;
      if (partial.ttsResumeGraceMs != null) opts.ttsResumeGraceMs = +partial.ttsResumeGraceMs;
      emit("config", getConfig());
      return getConfig();
    }

    /** UI / orb facing snapshot */
    function getState() {
      return {
        enabled,
        pipeline,
        vad,
        /** High-level turn state for visuals */
        voiceState:
          !enabled
            ? "idle"
            : pipeline === "speaking"
              ? "speaking"
              : pipeline === "thinking"
                ? "thinking"
                : vad === "capturing" || pipeline === "listening"
                  ? "listening"
                  : "idle",
        paused: vad === "paused" || pipeline === "speaking",
        config: getConfig(),
      };
    }

    return {
      setEnabled,
      isEnabled: () => enabled,
      notifyPipeline,
      processFrame,
      markCapturing,
      getState,
      getConfig,
      setConfig,
      enterWaiting,
    };
  }

  global.VoiceAuto = { create, DEFAULTS };
})(typeof window !== "undefined" ? window : globalThis);
