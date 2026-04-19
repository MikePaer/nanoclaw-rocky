---
name: personal-finance
description: Mike's Forecaster Budget API — review transactions, suggest recategorizations, manage rules, summarize balance changes, check budgets. Use for personal finance, transaction review, account balances, budget tracking, financial summaries.
---

# Forecaster Budget API

Personal finance tracker aggregating accounts, transactions, holdings, and budgets scraped from Empower.

**Base URL:** `$FORECASTER_API_URL` · **Auth:** `Authorization: Bearer $FORECASTER_API_KEY`

## Endpoints

### Transactions
| Method | Path | Notes |
|---|---|---|
| GET | `/api/transactions?dateFrom=YYYY-MM-DD&page=1&limit=50` | Paginated. Fields: `id, date, account_id, description, category, tags, amount, locally_edited, edited_by_rule, original_description, original_category` |
| PATCH | `/api/transactions/:id` | Body: `{ category?, description?, tags? }` |
| PATCH | `/api/transactions/bulk` | Body: `{ updates: [{id, ...}] }` — max 25 |
| GET | `/api/transactions/categories` | Distinct categories in use |
| GET | `/api/transactions/monthly-summary?months=3` | |
| GET | `/api/transactions/recurring` · `/recurring-income` · `/recurring-loans` | |

### Rules (auto-categorize on ingest)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/rules` | `{ id, condition_type, condition_value, action_description, action_category, apply_to_new }` |
| POST | `/api/rules/preview` | Body: `{ conditionType, conditionValue }` → up to 200 matches, no writes |
| POST | `/api/rules` | Body: `{ condition_type: "is"\|"contains"\|"pattern", condition_value, action_description?, action_category?, apply_to_new: 1 }` |
| POST | `/api/rules/:id/apply` | Apply retroactively |
| PATCH/DELETE | `/api/rules/:id` | |

### Accounts & Balances
| Method | Path | Notes |
|---|---|---|
| GET | `/api/accounts` | Types: `cash, credit_card, investment, mortgage, real_estate, retirement` |
| GET | `/api/accounts/balance-changes?since=YYYY-MM-DD` | Per-account deltas + net worth delta |
| GET | `/api/accounts/snapshot?date=YYYY-MM-DD` | Historical balances |

### Budget · Holdings · Scraper
| Method | Path | Notes |
|---|---|---|
| GET | `/api/budgets/vs-actual` · `/cashflow` | Current month |
| GET | `/api/holdings` | |
| GET | `/api/scraper/runs` · POST `/api/scraper/run` · `/run/force` | `run` honors 24h cooldown |

## Conventions

- Amounts signed: negative = expense/outflow, positive = income/credit
- Liability balances stored negative (e.g. `-5000` = $5000 owed)
- Dates: ISO `YYYY-MM-DD`
- Empower descriptions are garbled with payment-processor noise — clean for display: strip prefixes (`APL*PAY`, `SQ *`, `TST*`, `AMZN MKTP US*`), trailing reference codes, and city/state suffixes. Examples: `APL*PAY****QUIZOS*CALIFORNIA` → `Quiznos`, `AMZN MKTP US*AB1CD2EF3` → `Amazon`

## Rules of engagement

- **Never modify a transaction with `locally_edited=1`** — user set it manually
- `edited_by_rule=1` means a rule already touched it; only revisit if the category looks wrong
- **Never auto-apply** category, description, or rule changes — show before/after and wait for explicit approval
- For recurring merchants, prefer creating a rule over one-off edits. After approving a description rename, offer a rule using `condition_type: "contains"` with a stable substring of the raw description
- When suggesting recategorizations, first `GET /api/rules` to see if an existing rule should have matched
