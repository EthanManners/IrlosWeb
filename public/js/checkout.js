/* Cloud subscriptions go through Stripe's hosted Checkout: buttons carry
   data-checkout="cloud", and if the API call fails the anchor's href still
   works as a plain link. The backpack is sold through /checkout/ instead,
   which is a plain link and never reaches this file.

   This also fills the order status on /success/ for both. */
(function () {
  function endpoint(kind) {
    if (kind === 'cloud') return ['/api/checkout/cloud', {}];
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

  /* success page: hosted Checkout returns a session id, the site's own
     checkout form returns a PaymentIntent id. Either identifies the order.
     The webhook can lag the redirect, so poll a few times. */
  var box = document.getElementById('orderStatus');
  if (box) {
    var m = location.search.match(/[?&](?:session_id|payment_intent)=((?:cs|pi)_[A-Za-z0-9_]+)/);
    if (m) fill(m[1], 0);
  }
  function fill(id, attempt) {
    fetch('/api/order/' + id).then(function (r) {
      if (!r.ok) throw new Error('order ' + r.status);
      return r.json();
    }).then(function (o) {
      var html = '';
      if (o.sku === 'cloud') {
        html = 'Payment received. Every server is provisioned by hand, within 24 hours of payment. Connection details arrive by email.';
      } else if (o.sku === 'backpack-full') {
        html = 'Order received. Each bag is assembled and tested before it ships. Current ship window: <strong>' + o.shipDate + '</strong>. Updates come by email.';
      }
      if (html) box.innerHTML = html;
    }).catch(function () {
      /* Six tries at 1.5s covers a slow webhook without leaving the buyer
         staring at a spinner. The confirmation email is the real receipt. */
      if (attempt < 6) setTimeout(function () { fill(id, attempt + 1); }, 1500);
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
