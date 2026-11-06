'use strict';
// Core invoice logic: parse plain English, validate, compute totals in integer cents.

const MONEY = /\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/;
const MAX_ITEMS = 50;

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function toCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

function usd(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

function plain(cents) {
  return (cents / 100).toFixed(2);
}

function cleanDesc(text, client) {
  let d = String(text || '');
  if (client) d = d.replace(new RegExp('\\s+for\\s+' + client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
  d = d.replace(/\s+/g, ' ').trim();
  d = d.replace(/^(?:and|plus|then|also|at|of|the)\s+/i, '').replace(/\s+(?:and|plus|at|of|for)$/i, '');
  d = d.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  if (/^(?:and|plus|then|also|at|of|the|for|a|an)$/i.test(d)) d = '';
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : '';
}

// Deterministic parser. Works with no API key.
function parseJob(text) {
  const src = String(text || '').trim();
  if (!src) throw bad('Describe the job first.');
  if (src.length > 5000) throw bad('Description is too long (5000 characters max).');

  let taxPercent = 0;
  let dueDays = 14;
  const taxM = src.match(/(\d+(?:\.\d+)?)\s*%\s*(?:sales\s*)?tax/i);
  if (taxM) taxPercent = Number(taxM[1]);
  const dueM = src.match(/(?:\bdue\s+(?:in\s+)?|\bnet\s*)(\d+)\s*(?:days?)?/i);
  if (dueM) dueDays = Number(dueM[1]);

  let client = '';
  const clientM = src.match(/\bfor\s+([A-Z][A-Za-z0-9&'\- .]*?)(?=,|;|\n|\.(?:\s|$)|\s+(?:plus|and|due|at|with)\b|$)/);
  if (clientM) client = clientM[1].trim();

  const segments = src
    .split(/[\n;]|,(?!\d{3})|\s+plus\s+|\s+and\s+(?=\d+\s*(?:hours?|hrs?)|an?\s|\$)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const items = [];
  let pending = '';
  for (const seg of segments) {
    const hasMoney = MONEY.test(seg);
    if (!hasMoney && /%\s*(?:sales\s*)?tax/i.test(seg)) continue;
    if (!hasMoney && /^(?:due|net)\b/i.test(seg)) continue;
    const m = seg.match(MONEY);
    if (!m) {
      pending = cleanDesc(seg, client);
      continue;
    }
    const amount = Number(m[1].replace(/,/g, ''));
    let quantity = 1;
    let rest = seg;
    const h = seg.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
    if (h) {
      quantity = Number(h[1]);
      rest = rest.replace(h[0], '');
    }
    rest = rest
      .replace(MONEY, '')
      .replace(/(?:\bat\b|\bper\b|\ban\b|\ba\b|\/)\s*(?:hour|hr|h)\b/gi, '')
      .replace(/\b(?:flat|each|total|fee)\b/gi, '');
    const description = cleanDesc(rest, client) || pending || 'Services';
    pending = '';
    items.push({ description, quantity, unitCents: toCents(amount) });
  }
  if (!items.length) throw bad('No prices found. Include amounts like "$50/hour" or "$150 flat".');
  return normalizeInvoice({ client: client || 'Client', items, taxPercent, dueDays });
}

// Validates any invoice object (parser, LLM or browser) into a safe canonical shape.
function normalizeInvoice(input) {
  if (!input || typeof input !== 'object') throw bad('Invoice is missing.');
  const client = String(input.client || 'Client').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Client';
  if (!Array.isArray(input.items) || input.items.length === 0) throw bad('Invoice needs at least one line item.');
  if (input.items.length > MAX_ITEMS) throw bad(`Too many line items (max ${MAX_ITEMS}).`);
  const items = input.items.map((it, i) => {
    const quantity = Number(it && it.quantity);
    const unitCents = Number(it && it.unitCents);
    if (!(quantity > 0) || quantity > 10000 || !Number.isFinite(quantity)) throw bad(`Line ${i + 1}: quantity must be between 0 and 10000.`);
    if (!Number.isInteger(unitCents) || unitCents < 0 || unitCents > 100000000) throw bad(`Line ${i + 1}: price is invalid.`);
    const description = String((it && it.description) || 'Services').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Services';
    return { description, quantity: Math.round(quantity * 100) / 100, unitCents };
  });
  const taxPercent = Number(input.taxPercent || 0);
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) throw bad('Tax percent must be between 0 and 100.');
  const dueDays = Number(input.dueDays === undefined ? 14 : input.dueDays);
  if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) throw bad('Due days must be a whole number from 0 to 365.');
  return { client, items, taxPercent, dueDays };
}

function computeTotals(inv) {
  const lines = inv.items.map((it) => Math.round(it.quantity * it.unitCents));
  const subtotalCents = lines.reduce((a, b) => a + b, 0);
  const taxCents = Math.round((subtotalCents * inv.taxPercent) / 100);
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

function formatInvoice(inv) {
  const t = computeTotals(inv);
  const rows = inv.items.map((it, i) => `- ${it.description}: ${it.quantity} x ${usd(it.unitCents)} = ${usd(t.lines[i])}`);
  return [
    `Invoice for ${inv.client}`,
    ...rows,
    `Subtotal: ${usd(t.subtotalCents)}`,
    `Tax (${inv.taxPercent}%): ${usd(t.taxCents)}`,
    `Total: ${usd(t.totalCents)}`,
    `Due in ${inv.dueDays} days`,
  ].join('\n');
}

module.exports = { parseJob, normalizeInvoice, computeTotals, formatInvoice, usd, plain, toCents, bad };
