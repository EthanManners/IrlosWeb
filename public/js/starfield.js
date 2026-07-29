/* starfield hero canvas. Only runs on pages that have #stars. */
(function () {
  var cv = document.getElementById('stars');
  if (!cv) return;
  var ctx = cv.getContext('2d');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stars = [], W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var boost = 0, target = 0, raf = null;
  var COUNT = 320;

  function resize() {
    var r = cv.getBoundingClientRect();
    W = r.width; H = r.height;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    stars = [];
    for (var i = 0; i < COUNT; i++) {
      stars.push({
        x: (Math.random() - 0.5) * W * 1.6,
        y: (Math.random() - 0.5) * H * 1.6,
        z: Math.random() * W,
        pz: 0
      });
    }
  }

  function recycle(s) {
    s.x = (Math.random() - 0.5) * W * 1.6;
    s.y = (Math.random() - 0.5) * H * 1.6;
    s.z = W;
    s.pz = s.z;
  }

  function paintStatic() {
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var k = W / s.z;
      var sx = s.x * k + W / 2, sy = s.y * k + H / 2;
      if (sx < 0 || sx > W || sy < 0 || sy > H) continue;
      ctx.fillRect(sx, sy, Math.max(0.6, (1 - s.z / W) * 1.8), Math.max(0.6, (1 - s.z / W) * 1.8));
    }
  }

  function frame() {
    boost += (target - boost) * 0.045;
    var speed = 1.9 + boost * 13;

    ctx.fillStyle = 'rgba(8, 8, 10, 0.34)';
    ctx.fillRect(0, 0, W, H);

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.pz = s.z;
      s.z -= speed;
      if (s.z < 1) { recycle(s); continue; }

      var k = W / s.z, pk = W / s.pz;
      var sx = s.x * k + W / 2, sy = s.y * k + H / 2;
      var px = s.x * pk + W / 2, py = s.y * pk + H / 2;

      if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) { recycle(s); continue; }

      var d = 1 - s.z / W;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.18 + d * 0.72).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.5, d * 1.9);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!raf && !reduced) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  resize(); seed();
  if (reduced) { paintStatic(); }
  else {
    ctx.fillStyle = '#08080a'; ctx.fillRect(0, 0, W, H);
    start();
  }

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { resize(); seed(); if (reduced) paintStatic(); }, 150);
  });

  // hyperspace on the go-live button
  var go = document.getElementById('goLive');
  if (go) {
    go.addEventListener('mouseenter', function () { target = 1; });
    go.addEventListener('mouseleave', function () { target = 0; });
    go.addEventListener('focus', function () { target = 1; });
    go.addEventListener('blur', function () { target = 0; });
  }

  // don't burn cycles off-screen or in a background tab
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });
  new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) start(); else stop(); });
  }, { threshold: 0 }).observe(cv);
})();
