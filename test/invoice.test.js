'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseJob, computeTotals, normalizeInvoice } = require('../src/invoice');
const { buildOrderPayload, createCheckout } = require('../src/paypal');
const { extractInvoice } = require('../src/llm');
const { createServer } = require('../src/server');

const SAMPLE = 'Built a 5-page website for Acme Bakery, 12 hours at $50/hour, plus logo design $150 flat, 6% tax, due in 14 days';

test('parses client, items, tax and due date', () => {
  const inv = parseJob(SAMPLE);
  assert.strictEqual(inv.client, 'Acme Bakery');
  assert.strictEqual(inv.items.length, 2);
  assert.deepStrictEqual(
    inv.items.map((i) => [i.quantity, i.unitCents]),
    [[12, 5000], [1, 15000]]
  );
  assert.strictEqual(inv.taxPercent, 6);
  assert.strictEqual(inv.dueDays, 14);
});

test('hourly line inherits the preceding description, not a stray "at"', () => {
  const inv = parseJob(SAMPLE);
  assert.strictEqual(inv.items[0].description, 'Built a 5-page website');
  assert.strictEqual(inv.items[1].description, 'Logo design');
});

test('totals are exact integer cents', () => {
  const t = computeTotals(parseJob(SAMPLE));
  assert.strictEqual(t.subtotalCents, 75000);
  assert.strictEqual(t.taxCents, 4500);
  assert.strictEqual(t.totalCents, 79500);
});

test('handles thousands separators and fractional hours', () => {
  const inv = parseJob('Consulting for Dana LLC, 2.5 hours at $80/hour, hosting setup $1,200');
  const t = computeTotals(inv);
  assert.strictEqual(inv.client, 'Dana LLC');
  assert.strictEqual(t.subtotalCents, 20000 + 120000);
});

test('rejects empty text and text with no prices', () => {
  assert.throws(() => parseJob(''), /Describe the job/);
  assert.throws(() => parseJob('Did some work for Bob'), /No prices/);
});

test('normalizeInvoice rejects bad numbers', () => {
  assert.throws(() => normalizeInvoice({ client: 'x', items: [{ description: 'a', quantity: -1, unitCents: 100 }] }), /quantity/);
  assert.throws(() => normalizeInvoice({ client: 'x', items: [{ description: 'a', quantity: 1, unitCents: 1.5 }] }), /price/);
  assert.throws(() => normalizeInvoice({ client: 'x', items: [{ description: 'a', quantity: 1, unitCents: 100 }], taxPercent: 101 }), /Tax/);
});

test('PayPal payload amounts add up', () => {
  const p = buildOrderPayload(parseJob('Work for Dana LLC, 2.5 hours at $80/hour, setup $100, 10% tax'));
  const unit = p.purchase_units[0];
  const itemSum = unit.items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
  assert.strictEqual(itemSum.toFixed(2), unit.amount.breakdown.item_total.value);
  const total = Number(unit.amount.breakdown.item_total.value) + Number(unit.amount.breakdown.tax_total.value);
  assert.strictEqual(total.toFixed(2), unit.amount.value);
  assert.ok(unit.items.every((i) => Number.isInteger(Number(i.quantity))));
});

test('checkout without keys degrades to a dry run', async () => {
  const r = await createCheckout(parseJob(SAMPLE), {});
  assert.strictEqual(r.configured, false);
  assert.match(r.message, /PAYPAL_CLIENT_ID/);
  assert.ok(r.payload.purchase_units);
});

test('checkout with keys calls only the sandbox host', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/v1/oauth2/token')) return { ok: true, json: async () => ({ access_token: 't' }) };
    return { ok: true, json: async () => ({ id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/x' }] }) };
  };
  const r = await createCheckout(parseJob(SAMPLE), { PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' }, fake);
  assert.strictEqual(r.id, 'ORD1');
  assert.strictEqual(r.approveUrl, 'https://sandbox.paypal.com/x');
  assert.ok(calls.every((u) => u.startsWith('https://api-m.sandbox.paypal.com/')));
});

test('LLM failure falls back to the parser; bad LLM output is rejected', async () => {
  const env = { LLM_API_KEY: 'k' };
  const down = async () => ({ ok: false, status: 500 });
  const a = await extractInvoice(SAMPLE, env, down);
  assert.strictEqual(a.source, 'parser');
  assert.match(a.note, /built-in parser/);
  const evil = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ client: 'X', items: [{ description: 'a', quantity: -5, unit_price: 10 }] }) } }] }) });
  const b = await extractInvoice(SAMPLE, env, evil);
  assert.strictEqual(b.source, 'parser');
});

test('LLM output is used when valid', async () => {
  const good = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ client: 'Zed', items: [{ description: 'Site', quantity: 1, unit_price: 99.5 }], tax_percent: 0, due_days: 7 }) } }] }) });
  const r = await extractInvoice('anything', { LLM_API_KEY: 'k' }, good);
  assert.strictEqual(r.source, 'llm');
  assert.strictEqual(r.invoice.items[0].unitCents, 9950);
});

test('HTTP server: invoice, checkout dry run, bad input, 404', async () => {
  const server = createServer({});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const page = await fetch(base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Invoice Copilot/);

    const r1 = await post('/api/invoice', { text: SAMPLE });
    const d1 = await r1.json();
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(d1.totals.totalCents, 79500);

    const r2 = await post('/api/checkout', { invoice: d1.invoice });
    const d2 = await r2.json();
    assert.strictEqual(d2.configured, false);

    const r3 = await post('/api/invoice', { text: '' });
    assert.strictEqual(r3.status, 400);

    const r4 = await fetch(base + '/nope');
    assert.strictEqual(r4.status, 404);
  } finally {
    server.close();
  }
});
