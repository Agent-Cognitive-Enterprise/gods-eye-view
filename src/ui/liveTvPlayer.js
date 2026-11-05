/**
 * Plays one HLS stream into a <video> for LIVE TV (fork feature). hls.js where
 * the browser supports Media Source Extensions, else native HLS. The stream is
 * fetched by the browser straight from the broadcaster's CDN; our server is not
 * involved. A fatal error, or no picture within `startupMs`, reports failure
 * once, so the panel can try the channel's next source.
 *
 * @param {HTMLVideoElement} video
 * @param {string} url A source parseSource() accepted as `hls`.
 * @returns {() => void} Stops playback and releases the decoder.
 */
export function attachLiveStream(
  video,
  url,
  {
    loadHls = () => import('hls.js'),
    onPlaying = () => {},
    onFailure = () => {},
    startupMs = 20_000,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = {},
) {
  let disposed = false;
  let hls = null;
  let reported = false;
  const fail = (reason) => {
    if (disposed || reported) return;
    reported = true;
    onFailure(reason);
  };
  const timer = setTimer(() => fail('timeout'), startupMs);
  const playing = () => {
    if (disposed) return;
    clearTimer(timer);
    onPlaying();
  };
  const mediaError = () => fail('media');
  video.addEventListener('playing', playing);
  video.addEventListener('error', mediaError);
  video.playsInline = true;

  const start = () => {
    const attempt = video.play();
    attempt?.catch?.((error) => {
      // Autoplay with sound refused: play muted rather than not at all.
      if (!disposed && error?.name === 'NotAllowedError' && !video.muted) {
        video.muted = true;
        video.play()?.catch?.(() => fail('autoplay'));
      }
    });
  };

  loadHls()
    .then((module) => {
      if (disposed) return;
      const Hls = module?.default ?? module;
      if (Hls?.isSupported?.()) {
        hls = new Hls({ lowLatencyMode: false, backBufferLength: 30 });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data?.fatal) fail(`hls:${data.type ?? 'error'}`);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, start);
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType?.('application/vnd.apple.mpegurl')) {
        video.src = url;
        start();
      } else {
        fail('unsupported');
      }
    })
    .catch(() => fail('loader'));

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimer(timer);
    video.removeEventListener('playing', playing);
    video.removeEventListener('error', mediaError);
    hls?.destroy();
    hls = null;
    video.pause?.();
    video.removeAttribute('src');
    video.load?.();
  };
}
