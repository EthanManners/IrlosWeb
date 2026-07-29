/* shared header and footer, injected into <div data-chrome="header"> and
   <div data-chrome="footer">. Also fills [data-ship-date] from the server so
   the ship date has one source: server/lib/config.js. */
(function () {
  var CONTACT = 'CONTACT_EMAIL'; // unset, must be a real address before launch. See README open items.
  var SOURCE = 'https://github.com/EthanManners/Irlos';

  var here = location.pathname;

  var NAV = [
    ['/cloud.html', 'cloud'],
    ['/backpack.html', 'backpack'],
    ['/download.html', 'download'],
    [SOURCE, 'source']
  ];

  var head = document.querySelector('[data-chrome="header"]');
  if (head) {
    var links = NAV.map(function (l) {
      var ext = l[0].charAt(0) !== '/';
      return '<a href="' + l[0] + '"' +
        (ext ? ' target="_blank" rel="noreferrer"' : '') +
        (!ext && here === l[0] ? ' aria-current="page"' : '') +
        '>' + l[1] + '</a>';
    }).join('');
    head.innerHTML =
      '<a class="skip" href="#main">skip to content</a>' +
      '<header class="site-head"><div class="wrap head-row">' +
      '<a class="brand" href="/">irlos<span class="tld">.live</span></a>' +
      '<nav class="head-nav" aria-label="site">' + links + '</nav>' +
      '</div></header>';
  }

  var foot = document.querySelector('[data-chrome="footer"]');
  if (foot) {
    foot.innerHTML =
      '<footer><div class="wrap">' +
      '<div class="foot-row">' +
      '<span>irlos &middot; gpl-3.0</span>' +
      '<a href="' + SOURCE + '" target="_blank" rel="noreferrer">source</a>' +
      '<a href="' + SOURCE + '" target="_blank" rel="noreferrer">docs</a>' +
      '<a href="mailto:' + CONTACT + '">contact</a>' +
      '<a href="/terms.html">terms</a>' +
      '<a href="/refunds.html">refunds</a>' +
      '<a href="/privacy.html">privacy</a>' +
      '</div>' +
      '<div class="foot-legal">' +
      '(c) 2026. copyleft, all wrongs reserved.<br />' +
      'Not affiliated with or endorsed by Streamer University, Twitch, Kick or YouTube. Product names belong to their owners.<br />' +
      'Corresponding source: <a href="' + SOURCE + '" target="_blank" rel="noreferrer">github.com/EthanManners/Irlos</a>' +
      '</div>' +
      '</div></footer>';
  }

  var slots = document.querySelectorAll('[data-ship-date]');
  if (slots.length) {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.shipDate) return;
      [].forEach.call(slots, function (el) { el.textContent = c.shipDate; });
    }).catch(function () {});
  }
})();
