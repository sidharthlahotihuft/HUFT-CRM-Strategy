# HUFT CRM Strategy — run locally + connect MySQL

Two processes. The browser can't talk to MySQL directly, so a thin Node API sits in between:

```
index.html (browser)  ->  HTTP  ->  sales-api (Node/Express)  ->  MySQL @172.18.11.27
```

`index.html` ships with `USE_MOCK=true` and runs standalone with mock data built on the real
catalog. To go live you (1) start the API, (2) flip `USE_MOCK=false`.

---

## Step 0 — confirm your columns (2 min, saves all the guesswork)

The API needs to know your real column names. Dump them:

```
mysql -h 172.18.11.27 -u crm_ro -p Sales_Data -e "DESCRIBE sales_data;"
```

Then open `sales-api/server.js` and set the `COL` map (one block near the top) to match.
While you're there, sanity-check `NODE_RULES` — that's the block that rolls raw SKUs up into the
~30 strategy nodes (SWF Food, Hearty Dry, Meowsi Wet, …). Defaults match on brand/name tokens.

## Step 1 — start the sales-api

```
cd sales-api
cp .env.example .env
npm install
node --env-file=.env server.js
```

Edit `.env` first with the real `DB_PASS`. If your Node is older than 20.6 (no `--env-file`), use:

```
cd sales-api
set -a; source .env; set +a
node server.js
```

Confirm it's up and can see the DB:

```
curl -s http://localhost:8787/health
```

Expect `{"ok":true,...}`. If `ok:false`, the error tells you what's wrong (auth, host, VPN).
You must be on the network that can reach `172.18.11.27`.

## Step 2 — point the frontend at live data

In `index.html`, near the top of the script block:

```
const USE_MOCK = false;
const API_BASE = "http://localhost:8787";
```

## Step 3 — serve the frontend

The CDN `<script>` tags need HTTP (opening the file directly won't work). In a second terminal:

```
cd /path/to/crm-strategy
python3 -m http.server 5173
```

Open http://localhost:5173. The build badge (top-right) shows **LIVE** on success, **API OFFLINE**
(red) if it can't reach the API — in which case it stays on mock so the UI never breaks.

---

## What comes from where

- **Catalog, cohort briefs, strategy rules** — hard-coded in `index.html` (your real content).
- **Sales / Dashboard / Priorities** — live from `strategy_sales_by_product` (units + revenue per
  node for last month / same month LY / this quarter, computed in one query).
- **Audience cohorts (combo-buy)** — `strategy_combo_affinity`. Off by default (`ENABLE_AFFINITY=false`)
  because it's a self-join; the app uses its built-in suggestions until you turn it on. For production,
  back it with a materialized view + named RPC (same pattern as your other feeds) rather than the
  live self-join.
- **Assets + "worked / didn't work"** — the CleverTap CSV you upload in the app. Not from MySQL.

## Endpoints

| Path | Returns |
|---|---|
| `GET /health` | liveness + DB reachability |
| `GET /rest/v1/rpc/strategy_sales_by_product` | `[{id, lm:{units,rev}, ly:{...}, tq:{...}, d2cShare?}]` |
| `GET /rest/v1/rpc/strategy_combo_affinity` | `[{items, name, size, lift, push, why}]` (opt-in) |

Node ids in the API output must match the `CATALOG` ids in `index.html`.
