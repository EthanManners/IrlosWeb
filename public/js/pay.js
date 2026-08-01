/* The checkout form. Stripe Elements renders the card and address fields into
   iframes it owns, so no card data ever reaches this page or the server; what
   this file does is create the PaymentIntent, mount those fields, and confirm.

   The amount is never sent from here. The server reads it off the Stripe price
   and puts it on the PaymentIntent, and the form only ever displays it. */
(function () {
  var form = document.getElementById('payForm');
  if (!form) return;

  var payBtn = document.getElementById('payBtn');
  var msg = document.getElementById('payMsg');
  var emailInput = document.getElementById('coEmail');

  var stripe, elements, ready = false;

  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = 'co-msg' + (kind ? ' is-' + kind : '');
  }

  function fail(text) {
    say(text, 'error');
    payBtn.disabled = true;
    payBtn.textContent = 'unavailable';
  }

  if (!window.Stripe) {
    fail('The payment library did not load. Disable your blocker or email for an invoice.');
    return;
  }

  /* Two calls, both needed before the form can render: the publishable key
     from our config, and a PaymentIntent to attach the fields to. */
  Promise.all([
    fetch('/api/config').then(function (r) { return r.json(); }),
    fetch('/api/payment-intent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        if (!r.ok) throw new Error('intent ' + r.status);
        return r.json();
      })
  ]).then(function (res) {
    var cfg = res[0], intent = res[1];
    if (!cfg || !cfg.stripeKey) {
      /* Config problem, not a payment problem. Say so plainly rather than
         implying the buyer's card was the issue. */
      var e = new Error('no publishable key');
      e.config = true;
      throw e;
    }

    stripe = window.Stripe(cfg.stripeKey);

    /* Elements renders in its own iframe, so the site stylesheet cannot reach
       it. This is the same palette, restated in the variables it accepts. */
    elements = stripe.elements({
      clientSecret: intent.clientSecret,
      fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap' }],
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#00d4ff',
          colorBackground: '#0e0e10',
          colorText: '#e8e4da',
          colorDanger: '#ff6b6b',
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSizeBase: '16px',
          borderRadius: '0',
          spacingUnit: '4px'
        },
        rules: {
          /* these mirror the email field in irlos.css: same border, same
             fill, same focus ring, so our field and Stripe's look like one form */
          '.Input': { border: '1px solid #3d3d42', boxShadow: 'none', backgroundColor: '#131519' },
          '.Input:hover': { border: '1px solid #55555c' },
          '.Input:focus': { border: '1px solid #00d4ff', boxShadow: '0 0 0 1px #00d4ff', backgroundColor: '#0b0d0e' },
          '.Label': { color: '#948f86', fontSize: '11px', letterSpacing: '0.13em', textTransform: 'uppercase' },
          '.Tab': { border: '1px solid #3d3d42', backgroundColor: '#131519' },
          '.Tab:hover': { border: '1px solid #55555c' },
          '.Tab--selected': { border: '1px solid #00d4ff', color: '#00d4ff' },
          '.Error': { color: '#ff8080', fontSize: '12px' }
        }
      }
    });

    elements.create('payment', { layout: 'tabs' }).mount('#paymentElement');
    elements.create('address', {
      mode: 'shipping',
      /* address autocomplete would pull in Google Maps, which the CSP does not
         allow and the checkout does not need */
      autocomplete: { mode: 'disabled' }
    }).mount('#addressElement');

    if (intent.display) {
      [].forEach.call(document.querySelectorAll('[data-price]'), function (el) {
        el.textContent = intent.display;
      });
    }

    ready = true;
    payBtn.disabled = false;
    payBtn.textContent = 'confirm order' + (intent.display ? ' · ' + intent.display : '');
  }).catch(function (err) {
    console.error('[pay]', err.message);
    fail(err.config
      ? 'Ordering is not switched on yet. Nothing has been charged. Email us and we will send an invoice directly.'
      : 'Checkout could not start. Nothing has been charged. Try again shortly, or email us for an invoice.');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!ready || payBtn.disabled) return;

    var email = (emailInput.value || '').trim();
    if (!email || email.indexOf('@') < 1) {
      say('Enter the email the order confirmation should go to.', 'error');
      emailInput.focus();
      return;
    }

    payBtn.disabled = true;
    payBtn.textContent = 'confirming';
    say('Contacting your bank. Do not close this tab.');

    stripe.confirmPayment({
      elements: elements,
      confirmParams: {
        /* Stripe returns here after any bank redirect, with the intent id in
           the query. /success/ reads it and polls for the recorded order. */
        return_url: location.origin + '/success/',
        receipt_email: email,
        payment_method_data: { billing_details: { email: email } }
      }
    }).then(function (result) {
      /* Only reached when confirmation fails: a success redirects away. */
      var e2 = result.error;
      payBtn.disabled = false;
      payBtn.textContent = 'confirm order';
      if (e2 && (e2.type === 'card_error' || e2.type === 'validation_error')) {
        say(e2.message, 'error');
      } else {
        say('That payment did not go through, and nothing was charged. Check the details and try again.', 'error');
      }
    });
  });
})();
