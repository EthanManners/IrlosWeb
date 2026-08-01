# TASK 4: Stripe configuration, test mode

Set up the Stripe objects the site needs. No server access, no code, no repo access. Dashboard and documentation only.

Independent of every other task. Run any time.

## Rules

- **Test mode only.** Every object you create is a test object.
- Do not read, modify, or reference live keys, live products, or the live webhook endpoint.
- Do not touch any existing object, test or live.
- You have no shell access. If a step seems to require it, that step is not yours.

## Products and prices

Three products. The descriptions render on the Checkout page, so they do real work.

**IRLOS Cloud**, recurring, $30.00 USD monthly:
> Managed relay server with IrlosStudio. Dedicated SRT ingest, forwarding to any platform, automatic bitrate management, and chat commands. Provisioned within 24 hours. Cancel any time.

**IRLOS Backpack**, one time, $1,000.00 USD:
> IRL streaming backpack, assembled and tested. Orange Pi 5 Plus, internal 4G modem, swappable USB-C battery, STREAM button on the strap. Includes 3 months of IRLOS Cloud. You add a SIM and a camera. Ships by SHIP_DATE.

**IRLOS Backpack Deposit**, one time, $99.00 USD:
> Reserves your place in the first production run and locks the price. Refundable until your build starts. Applied against the $1,000 balance, which is due before shipping. Ships by SHIP_DATE.

`SHIP_DATE` is a literal placeholder. Leave it. Flag in your report that both backpack descriptions carry it, because a description is a term of sale the moment a customer reads it at checkout, and these two products must not go live until it is a real date.

## Settings

- **Statement descriptor:** `IRLOS LIVE`. Max 22 characters, letters numbers and spaces only. Identical across all three, so a customer recognising the charge never disputes it out of confusion. That is the cheapest chargeback prevention available.
- **Customer Portal:** enable it under Settings, Billing. Without it, `/api/portal` returns 400 and nobody can cancel or update a card without emailing the operator.
- Configure the portal to allow cancellation and payment method updates. Do not allow plan switching, there is only one plan.
- **Tax:** leave automatic tax off for now. Note it as an open question in your report rather than deciding it.

## Webhook

A **new** endpoint, separate from anything live:

- URL `https://irlos.live/api/webhook`
- Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`

Send a test event and record the response code. A 400 is expected if the app is not deployed yet, and that is fine, note it.

## Deliverable

`STRIPE_TEST_CONFIG.md` containing:

- every product and price id you created, clearly labelled test
- the webhook endpoint id
- the exact env var names the app needs, matched to values, **with the secret values redacted**. Names and which id goes where, not the secrets themselves.
- what you enabled in the portal
- open questions: tax, the `SHIP_DATE` placeholder, anything else you hit

Never write a secret key or a webhook signing secret into a file in the repo. Note where they are retrieved from in the dashboard.

## Stop and ask if

- an object with a conflicting name already exists
- you cannot tell whether something is a test or live object
- the account has restrictions that block any of the above
