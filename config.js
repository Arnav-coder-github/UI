/* ============================================================
   AURA runtime endpoints
   ------------------------------------------------------------
   Keep these in sync with Common/Config/url_config.json.
   The Vercel UI connects OUT to ASR/TTS; TTS does NOT call Vercel.
   ============================================================ */
window.AURA_CONFIG = {
  // HTTP fallback used by the Speak → Stop path
  asrUrl:
    "https://cherelle-sandiest-voluminously.ngrok-free.dev/transcribe_stream",

  // Socket.IO origin only (no /tts path) — UI plays audio from here
  ttsSocketUrl:
    "https://dizygotic-marlyn-disobediently.ngrok-free.dev",

  // Optional: skip ngrok free-tier interstitial from the browser
  ngrokSkipBrowserWarning: "69420",
};
