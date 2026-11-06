'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { extractInvoice } = require('./llm');
const { computeTotals, formatInvoice, normalizeInvoice } = require('./invoice');
const { createCheckout } = require('./paypal');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('Request too large.');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function jsonBody(req) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err.status) throw err;
    const bad = new Error('Body must be valid JSON.');
    bad.status = 400;
    throw bad;
  }
}

function createServer(env = process.env, fetchImpl = fetch) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && req.url === '/api/invoice') {
        const { text } = await jsonBody(req);
        const { invoice, source, note } = await extractInvoice(text, env, fetchImpl);
        return send(res, 200, { invoice, totals: computeTotals(invoice), summary: formatInvoice(invoice), source, note });
      }
      if (req.method === 'POST' && req.url === '/api/checkout') {
        const { invoice } = await jsonBody(req);
        const result = await createCheckout(normalizeInvoice(invoice), env, fetchImpl);
        return send(res, 200, result);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (err) {
      const status = err.status || 502;
      return send(res, status, { error: err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Invoice Copilot running at http://127.0.0.1:${port}`);
    console.log(process.env.PAYPAL_CLIENT_ID ? 'PayPal sandbox keys: set' : 'PayPal sandbox keys: not set (dry-run mode)');
    console.log(process.env.LLM_API_KEY ? 'AI step: on' : 'AI step: off (built-in parser)');
  });
}

module.exports = { createServer };
