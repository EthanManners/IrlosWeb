/* boot log terminal animation. Only runs on pages that have #termBody. */
(function () {
  var body = document.getElementById('termBody');
  if (!body) return;
  var lines = [].slice.call(body.querySelectorAll('.ln'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];

  function play() {
    timers.forEach(clearTimeout); timers = [];
    if (reduced) { lines.forEach(function (l) { l.classList.add('on'); }); return; }
    lines.forEach(function (l) { l.classList.remove('on'); });
    var d = 0;
    lines.forEach(function (line, i) {
      d += (i === 7 || i === 11) ? 600 : 215;
      timers.push(setTimeout(function () { line.classList.add('on'); }, d));
    });
  }

  var fired = false;
  new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting && !fired) { fired = true; play(); } });
  }, { threshold: 0.25 }).observe(body);

  var replay = document.getElementById('replay');
  if (replay) replay.addEventListener('click', play);
})();
