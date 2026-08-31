# stackspots-events

Node backend that fetches Stackspots contract print logs from the Hiro API, fully decodes Clarity values for a frontend, and caches them in Redis (`node-redis`).

## What it returns

Each event includes:

- `values` — unwrapped JSON. `uint`/`int` are **strings**, `optional none` is `null`, principals are strings (`ST…` or `ST….contract`), buffers are `0x…` hex, tuples are objects, lists are arrays.
- `clarity` — the same tree with `{ type, value }` so the UI knows a field is `uint` vs `principal` vs `buff`.

Print wrappers from Clarity are peeled before that:

- `(print (to-consensus-buff? { … }))` → `(optional (buff))` of a serialized tuple
- `(print payload)` from `log-*` → `(buff 2048)` of a serialized tuple

Nested buffer **fields** (contract hashes) stay as hex.

## Setup

```bash
cd stackspots-events
cp .env.example .env
# edit NETWORK (default when ?network= is omitted), STACKSPOTS_CONTRACT_MAINNET, and STACKSPOTS_CONTRACT_TESTNET
npm install
```

Redis must be running at `REDIS_URL` (default `redis://127.0.0.1:6379`).

```bash
npm start
```

Dev reload: `npm run dev`. Decoder tests: `npm test`.

## Env

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `NETWORK` | required | Default when `?network=` is omitted (`mainnet` or `testnet`) |
| `STACKSPOTS_CONTRACT_MAINNET` | from `STACKSPOTS_CONTRACT` if `SP`/`SM` | Mainnet Stackspots `address.name` |
| `STACKSPOTS_CONTRACT_TESTNET` | from `STACKSPOTS_CONTRACT` if `ST`/`SN` | Testnet Stackspots `address.name` |
| `STACKSPOTS_CONTRACT` | — | Fallback mapped to mainnet or testnet from the principal prefix |
| `STACKS_API_URL` | from `NETWORK` | Optional override for the selected network |
| `STACKS_MAINNET_API_URL` | `https://api.hiro.so` | Mainnet Hiro host |
| `STACKS_TESTNET_API_URL` | `https://api.testnet.hiro.so` | Testnet Hiro host |
| `SYNC_INTERVAL_MS` | `15000` | Poll interval (`0` disables) |
| `CACHE_TTL_SECONDS` | `0` | `0` = keep events forever |
| `PAGE_SIZE` | `50` | Hiro page size |
| `MAX_SYNC_PAGES` | `80` | Max pages per sync |
| `CONTRACT_CACHE_TTL_SECONDS` | `15` | Redis TTL for read-only call results (`0` = forever) |
| `DEFAULT_READ_FUNCTION` | `get-pot-details` | Function used when `/contracts` has no `function` |

## HTTP

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Redis + last sync. `?network=mainnet\|testnet` selects contract + Hiro |
| `GET` | `/catalog` | Known event names/fields |
| `GET` | `/events` | `network`, `event`, `pot`, `limit`, `offset`, `raw=1` |
| `GET` | `/events/:id` | One event including raw hex |
| `GET` | `/pots` | `network`, `status=deployed\|joinable\|started\|cancelled\|claimed` |
| `GET` | `/stats` | Same as pots, plus join/stake/claim totals (`/pots/stats` alias) |
| `GET`/`POST` | `/contracts/:address/:name/:function` | Read-only call on that contract |
| `GET`/`POST` | `/contracts/:address.name/:function` | Same, `ADDRESS.NAME` + function |
| `GET`/`POST` | `/contracts/:address/:name` | Same, function via `?function=` (default `get-pot-details`) |
| `GET`/`POST` | `/contracts?address=&function=` | Same, query or JSON body |
| `POST` | `/sync` | Pull new logs (`?network=testnet` one chain, omit to sync both, `?full=1` all pages) |

`GET /events` example:

```json
{
  "events": [
    {
      "id": "0xabc…:0",
      "txId": "0xabc…",
      "event": "join-pot",
      "values": {
        "event": "join-pot",
        "participant": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
        "amount": "25000000",
        "index": "0"
      },
      "clarity": {
        "type": "tuple",
        "value": {
          "amount": { "type": "uint", "value": "25000000" }
        }
      }
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

Pass `?network=mainnet` or `?network=testnet` on every route. The backend uses that to pick Hiro (`api.hiro.so` / `api.testnet.hiro.so`), the matching `STACKSPOTS_CONTRACT_*`, and the Redis namespace `stackspots:mainnet` vs `stackspots:testnet`. Responses include `network`, `networkSource` (`query` or `default`), `contract`, and `stacksApiUrl`.

```http
GET /health?network=testnet
GET /pots?network=testnet
GET /events?network=mainnet
POST /sync?network=testnet
```

Omit `network` to use `NETWORK` from `.env`.

Every contract print with an `event` key is indexed. Platform prints (`admin added/updated`, `public pot deploy status updated`, `pot contract hash set`) stay on `/events` only. Pot prints update the matching pot row:

| Event key | Pot status |
| --- | --- |
| `pre-init` | deployed |
| `init-pot`, `pot-registered`, `pot mint`, `join-pot`, `join-pot-as-sponsor` | joinable |
| `start-stackspot-jackpot`, `start-stackspot-crowdfund`, `start-stackspot-sequential-pot`, `stake-treasury`, `extend-stake`, `revoke-stake`, `pull-staking-rewards-cycle` | started |
| `cancel-pot`, `fall-back-cancel` | cancelled |
| `claim-pot-reward` | claimed |

Status only moves forward. Sync pulls Stackspots first, then each known pot contract, so pot-only prints (`init-pot`, `start-stackspot-*`, `stake-treasury`, …) are included. Join/claim prints that appear on both the pot and Stackspots are counted once.

`GET /contracts/:address/:name/:function` runs Hiro `call-read` on that contract. Pass `sender` when the read uses `tx-sender`. Optional `args` (JSON array) and `refresh=1`.

```http
GET /contracts/ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM/jackpot/get-pot-details?sender=ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
GET /contracts/ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot/get-pot-value
POST /contracts/ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM/jackpot/get-pot-participant-values
Content-Type: application/json

{ "sender": "ST1…", "args": ["ST1…"] }
```

The response uses the same Clarity decoding as events: `values` (unwrapped) and `clarity` (typed). `(ok …)` is unwrapped into `ok: true` plus the inner tuple; `(err …)` is `ok: false` with the error value.

`GET /stats` (or `GET /pots/stats`) uses those same status buckets (`byStatus` / `totals.deployed|joinable|started|cancelled|claimed`). It also rolls up unique participants/sponsors, STX joined/sponsored, deploy fees, STX staked, sBTC yield claimed, and Fastpool `paid` amounts. Dual pot+Stackspots prints of the same action are not double-counted. Amounts stay strings. Pass `?refresh=1` to recompute.
