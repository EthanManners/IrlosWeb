/* hero video controls. The clip autoplays muted and loops; the bar under it
   toggles sound and playback. Reduced motion and Save-Data get the poster and a
   play button instead of a 2.7MB autoplay. Inline scripts are blocked by the
   CSP, so this lives in its own file. */
(function () {
  var vid = document.getElementById('reelVid');
  if (!vid) return;

  var playBtn = document.getElementById('reelPlay');
  var soundBtn = document.getElementById('reelSound');
  var reduced = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
    (navigator.connection && navigator.connection.saveData);

  function setPlayLabel() { playBtn.textContent = vid.paused ? 'play' : 'pause'; }

  if (reduced) {
    vid.removeAttribute('autoplay');
    vid.pause();
  } else {
    // Safari and any browser with autoplay blocked reject this promise
    var p = vid.play();
    if (p && p.catch) p.catch(function () { setPlayLabel(); });
  }
  setPlayLabel();

  playBtn.addEventListener('click', function () {
    if (vid.paused) vid.play(); else vid.pause();
  });
  vid.addEventListener('play', setPlayLabel);
  vid.addEventListener('pause', setPlayLabel);

  soundBtn.addEventListener('click', function () {
    vid.muted = !vid.muted;
    soundBtn.textContent = vid.muted ? 'sound' : 'mute';
    soundBtn.setAttribute('aria-pressed', vid.muted ? 'false' : 'true');
    // unmuting a paused clip should start it, otherwise the button does nothing visible
    if (!vid.muted && vid.paused) vid.play();
  });

  // don't burn cycles or data decoding a clip nobody is looking at
  new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) {
        if (!reduced && vid.dataset.autopaused) { delete vid.dataset.autopaused; vid.play(); }
      } else if (!vid.paused) {
        vid.dataset.autopaused = '1';
        vid.pause();
      }
    });
  }, { threshold: 0.15 }).observe(vid);
})();
