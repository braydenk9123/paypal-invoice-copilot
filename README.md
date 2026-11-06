# Invoice Copilot

Describe a freelance job in plain English. Invoice Copilot turns it into a clean invoice with exact totals, then creates a PayPal checkout order in the PayPal **sandbox**.

Example input:

> Built a 5-page website for Acme Bakery, 12 hours at $50/hour, plus logo design $150 flat, 6% tax, due in 14 days

Output: two line items, subtotal $750.00, tax $45.00, total $795.00, due in 14 days, and a PayPal sandbox order.

## How it uses PayPal and AI

- **PayPal:** the app calls the PayPal Orders v2 API (`/v2/checkout/orders`) on the sandbox host `https://api-m.sandbox.paypal.com`. That host is hard-coded, so the app cannot move real money.
- **AI:** an optional LLM step extracts the invoice from free text. It works with any OpenAI-compatible chat endpoint. The model output is untrusted and is validated before use. If the AI step is off or fails, a built-in deterministic parser takes over.

## Run it (Node 18 or newer, no install step)

```
node src/server.js
```

Open http://127.0.0.1:3000.

With no keys set, everything works in dry-run mode: the page shows the exact PayPal request that would be sent.

## Optional environment variables

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox app credentials (create a free app at https://developer.paypal.com/). Enables real sandbox orders. |
| `LLM_API_KEY` | Turns on the AI extraction step. |
| `LLM_BASE_URL` | Default `https://api.openai.com/v1`. Any OpenAI-compatible endpoint works. |
| `LLM_MODEL` | Default `gpt-4o-mini`. |
| `PORT` | Default 3000. |

## Tests

```
node --test
```

12 tests cover parsing, integer-cent totals, PayPal payload arithmetic, sandbox-only host use, LLM fallback, rejection of bad model output, and the HTTP server.

## Limits

- The built-in parser handles common phrasing ("12 hours at $50/hour", "$150 flat", "6% tax", "due in 14 days"). Unusual wording works best with the AI step on.
- Sandbox only. It does not capture payments after approval.

## License

MIT. See `LICENSE`.
