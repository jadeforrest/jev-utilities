# jev-utilities

Small helpers for categorizing data with [TypeSafe's Jev](https://docs.typesafe.ai),
a "System One" decision model. Jev doesn't write text: you give it some state and a
choice question, and it returns one of your labels with a probability distribution
and a confidence score.

The point of this package is to make a categorization job a two-file affair, and to
**flag uncertain items for a human instead of guessing**. Anything below the confidence
threshold comes back with `label: null`, Jev's best guess in `suggestion`, and
`needsReview: true`.

This package is the single home of the Jev client: `~/Developer/email-narrative`
depends on it (`"jev-utilities": "file:../jev-utilities"`) and no longer has its own
copy, so retry and validation fixes land once. Run `npm run build` here after changing
`src/`; email-narrative rebuilds it automatically before its own build, tests and runs.

## Setup

```sh
./install.sh         # npm ci if needed, build, link ~/.local/bin/jev-categorize
./install.sh --uninstall
```

The link points at `bin/jev-categorize`, which follows symlinks and finds node itself
(`$JEV_NODE`, else node on PATH, else nvm's default version), so it also runs under
launchd's minimal PATH. It never replaces a file it didn't create; set `PREFIX` to
install somewhere other than `~/.local`. After changing `src/`, `npm run build` is
enough: the link stays live.

Set `TYPESAFE_API_KEY`, or pass `--env-file` pointing at a dotenv file containing it.

## CLI

```sh
jev-categorize --categories cats.json --input items.json [--output results.json] \
  [--min-confidence 0.6] [--concurrency 8] [--model jev-latest] [--env-file .env] [--dry-run]
```

Without building: `npx tsx src/cli.ts ...` (or `npm run categorize -- ...`).

**`cats.json`** — the question and the allowed labels. Jev reads descriptions literally
and doesn't infer intent, so put each rule on the label it qualifies:

```json
{
  "question": "Which kind of support request is this?",
  "categories": {
    "billing": "Questions about invoices, charges, refunds or payment methods.",
    "bug": "Something in the product is broken or behaves unexpectedly.",
    "other": "Anything that fits none of the other categories."
  },
  "minConfidence": 0.6
}
```

**`items.json`** — what to categorize. `state` is what Jev sees: a string or an object.
Ids must be unique.

```json
[
  { "id": 1, "state": "I was charged twice this month" },
  { "id": 2, "state": { "subject": "Export button does nothing", "body": "..." } }
]
```

**Output** — one result per item, in input order:

```json
{ "id": 2, "label": null, "suggestion": "bug", "confidence": 0.41,
  "probabilities": { "bug": 0.55, "other": 0.3, "billing": 0.15 }, "needsReview": true }
```

A failed call (after retries) yields `label: null, suggestion: null, needsReview: true`
and an `error` string — failures are visible in the output, never dropped. A summary
(labeled/review/failed counts, tokens, cost) goes to stderr.

Exit codes: `0` success (including items flagged for review), `1` bad usage or input,
`2` every item failed (bad key or outage).

`--dry-run` prints the request for the first item plus a token/cost estimate and sends
nothing; no key needed. Use it to check what a third party will see before a real run.

### Threshold

`--min-confidence` beats the spec's `minConfidence`, which beats the default `0.5`. An
answer exactly at the threshold is accepted.

## Library

```ts
import { JevClient, categorize, parseSpec, parseItems } from 'jev-utilities';

const client = new JevClient(process.env.TYPESAFE_API_KEY!, { model: 'jev-latest' });
const { results, costUsd } = await categorize(client, spec, items, { minConfidence: 0.6 });
```

`JevClient.systemOne()` is also usable directly for multi-question calls.

## Privacy

Every item's `state` is sent to TypeSafe's API. Keep it to what the decision needs —
an excerpt, not a whole record — and use `--dry-run` to see exactly what goes out.

## Cost and limits

Jev bills input tokens only, $0.042 per million. The API allows ~40 requests/s; the
default concurrency of 8 stays well inside that. 429/5xx/529 are retried with
exponential backoff (5 attempts); other errors get one retry.

## Development

```sh
npm test               # node:test + fast-check property tests
npm run coverage       # c8
npm run test:mutation  # StrykerJS — slow pass, run after merging
```
