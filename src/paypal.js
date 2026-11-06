'use strict';
// PayPal SANDBOX only. The base URL is fixed so this app can never touch live money.

const { computeTotals, plain, usd, normalizeInvoice } = require('./invoice');

const BASE = 'https://api-m.sandbox.paypal.com';

function trunc(s, n) {
  return String(s).slice(0, n);
}

// Pure function: builds the Orders v2 request body. PayPal needs integer item quantities,
// so a fractional quantity (e.g. 2.5 hours) is sent as one line with the line total.
function buildOrderPayload(rawInvoice) {
  const inv = normalizeInvoice(rawInvoice);
  const t = computeTotals(inv);
  const items = inv.items.map((it, i) => {
    if (Number.isInteger(it.quantity)) {
      return {
        name: trunc(it.description, 127),
        quantity: String(it.quantity),
        unit_amount: { currency_code: 'USD', value: plain(it.unitCents) },
      };
    }
    return {
      name: trunc(`${it.description} (${it.quantity} x ${usd(it.unitCents)})`, 127),
      quantity: '1',
      unit_amount: { currency_code: 'USD', value: plain(t.lines[i]) },
    };
  });
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: 'invoice-1',
        description: trunc(`Invoice for ${inv.client}`, 127),
        amount: {
          currency_code: 'USD',
          value: plain(t.totalCents),
          breakdown: {
            item_total: { currency_code: 'USD', value: plain(t.subtotalCents) },
            tax_total: { currency_code: 'USD', value: plain(t.taxCents) },
          },
        },
        items,
      },
    ],
  };
}

function hasKeys(env) {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

async function getAccessToken(env, fetchImpl = fetch) {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetchImpl(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PayPal sandbox rejected the credentials (HTTP ${res.status}).`);
  const data = await res.json();
  if (!data.access_token) throw new Error('PayPal sandbox returned no access token.');
  return data.access_token;
}

// Returns { configured:false, ... } when no keys are set, so the demo still works for judges.
async function createCheckout(rawInvoice, env, fetchImpl = fetch) {
  const payload = buildOrderPayload(rawInvoice);
  if (!hasKeys(env)) {
    return {
      configured: false,
      message: 'PayPal sandbox keys are not set. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to create a real sandbox order. This is the request that would be sent.',
      payload,
    };
  }
  const token = await getAccessToken(env, fetchImpl);
  const res = await fetchImpl(`${BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal order creation failed (HTTP ${res.status}): ${data.message || 'no detail'}`);
  const link = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { configured: true, id: data.id, status: data.status, approveUrl: link ? link.href : null };
}

module.exports = { buildOrderPayload, createCheckout, hasKeys, BASE };
