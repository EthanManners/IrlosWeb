/* sends buy clicks to the server, which owns every price.
   Buttons carry data-checkout="cloud" | "backpack-full" | "backpack-deposit".
   If the API call fails the anchor's href still works as a plain link. */
(function () {
  function endpoint(kind) {
    if (kind === 'cloud') return ['/api/checkout/cloud', {}];
    if (kind === 'backpack-full') return ['/api/checkout/backpack', { variant: 'full' }];
    if (kind === 'backpack-deposit') return ['/api/checkout/backpack', { variant: 'deposit' }];
    return null;
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-checkout]') : null;
    if (!el) return;
    var ep = endpoint(el.getAttribute('data-checkout'));
    if (!ep) return;
    e.preventDefault();
    if (el.dataset.busy) return;
    el.dataset.busy = '1';
    var was = el.textContent;
    el.textContent = 'contacting stripe';

    fetch(ep[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ep[1])
    }).then(function (r) {
      if (!r.ok) throw new Error('checkout ' + r.status);
      return r.json();
    }).then(function (data) {
      if (data && data.url) { location.href = data.url; return; }
      throw new Error('no session url');
    }).catch(function () {
      delete el.dataset.busy;
      el.textContent = was;
      // fall back to the plain page link so the click still goes somewhere
      if (el.href) location.href = el.href;
    });
  });

  // success page: the webhook can lag the redirect, so poll a few times
  var box = document.getElementById('orderStatus');
  if (box) {
    var m = location.search.match(/[?&]session_id=(cs_[A-Za-z0-9_]+)/);
    if (m) fill(m[1], 0);
  }
  function fill(id, attempt) {
    fetch('/api/order/' + id).then(function (r) {
      if (!r.ok) throw new Error('order ' + r.status);
      return r.json();
    }).then(function (o) {
      var html = '';
      if (o.sku === 'cloud') {
        html = 'Payment received. I provision every server by hand, within 24 hours of payment. Connection details arrive by email.';
      } else if (o.sku === 'backpack-full') {
        html = 'Order received. Each bag is assembled and tested before it ships. Current ship window: <strong>' + o.shipDate + '</strong>. Updates come by email.';
      } else if (o.sku === 'backpack-deposit') {
        html = 'Deposit received. You are <strong>number ' + o.queuePosition + '</strong> in the build queue. Current ship window: <strong>' + o.shipDate + '</strong>. The $99 is <a href="/refunds.html">refundable until your build starts</a>.';
      }
      if (html) box.innerHTML = html;
    }).catch(function () {
      if (attempt < 3) setTimeout(function () { fill(id, attempt + 1); }, 1500);
    });
  }

  // billing portal: form with data-portal and an email input
  var pf = document.querySelector('form[data-portal]');
  if (pf) {
    pf.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = pf.querySelector('input[type="email"]');
      var note = pf.querySelector('[data-portal-note]');
      fetch('/api/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email ? email.value : '' })
      }).then(function (r) {
        if (!r.ok) throw new Error('portal ' + r.status);
        return r.json();
      }).then(function (data) {
        if (data && data.url) { location.href = data.url; return; }
        throw new Error('no portal url');
      }).catch(function () {
        if (note) note.textContent = 'no subscription found for that email. If that looks wrong, email me.';
      });
    });
  }
})();
