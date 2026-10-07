# Evaluation results

Held-out set: 30 cases (27 in-scope, 1 per intent, + 3 crafted out-of-scope) from the Bitext customer-support dataset — never used for threshold calibration (that used the dev split, see src/scripts/calibrate.ts).

Two configurations:
- **A — routing ON**: retrieval dominance >= 0.75 short-circuits to the extractive backend (verbatim KB answer, zero cost).
- **B — routing OFF**: every request is synthesized by the real model (`openai/gpt-oss-20b`).

Answer quality method: token-level ROUGE-1 / ROUGE-L F1 against the ground-truth response plus an LLM judge (1-5, sample of 15 answered cases) — the judge calls the provider directly, outside the metered gateway path.

| metric | A: routing ON (short-circuit 0.75) | B: routing OFF (always real model) |
|---|---|---|
| intent accuracy (27 in-scope) | 88.9% | 85.2% |
| retrieval-vote intent accuracy (groq cases) | 91.7% | 100% |
| LLM-reported intent accuracy (groq cases) | 100% | 100% |
| answer ROUGE-1 F1 | 0.426 | 0.470 |
| answer ROUGE-L F1 | 0.294 | 0.310 |
| refusal accuracy (3 out-of-scope) | 100% | 100% |
| in-scope refusal rate | 11.1% | 11.1% |
| TTFB p50 / p95 (ms) | 254 / 694 | 345 / 606 |
| total latency p50 / p95 (ms) | 714 / 5472 | 701 / 6978 |
| tokens in / out (metered) | 23639 / 3055 | 24384 / 3640 |
| metered cost (USD) | $0.00131 | $0.000943 |
| route rules | short_circuit:10, default:13, no_evidence_refusal:6, fallback_error:1 | fallback_error:14, default:10, no_evidence_refusal:6 |
| outcomes | ok:23, refused:6, fallback:1 | fallback:14, ok:10, refused:6 |

## Notes

- Latency percentiles are client-measured (the eval script is the client).
- Tokens/cost come from the gateway metering (provider-reported on the groq path, chars/4 estimated on the extractive path).
- Out-of-scope refusal accuracy: correct behaviour is refusing (coverage gate), not guessing.

## Raw results per case

### Config A — routing ON (short-circuit 0.75)

| # | expected | outcome | backend | intent | conf | R1 | ttfb | total |
|---|---|---|---|---|---|---|---|---|
| 1 | cancel_order | ok | extractive | cancel_order | 0.917 | 0.76 | 252 | 6902 |
| 2 | change_order | ok | groq | change_order | 0.787 | 0.28 | 694 | 770 |
| 3 | change_shipping_address | ok | extractive | change_shipping_address | 0.7 | 0.63 | 253 | 1727 |
| 4 | check_cancellation_fee | ok | groq | check_cancellation_fee | 0.897 | 0.45 | 347 | 469 |
| 5 | check_invoice | ok | groq | check_invoice | 0.889 | 0.37 | 569 | 714 |
| 6 | check_payment_methods | ok | groq | check_payment_methods | 0.784 | 0.3 | 527 | 610 |
| 7 | check_refund_policy | ok | groq | check_refund_policy | 0.839 | 0.32 | 285 | 411 |
| 8 | complaint | refused | none | — | 0.6 | 0.13 | 0 | 1 |
| 9 | contact_customer_service | ok | extractive | contact_customer_service | 0.833 | 0.63 | 254 | 2595 |
| 10 | contact_human_agent | refused | none | — | 0.451 | 0.23 | 0 | 0 |
| 11 | create_account | ok | groq | create_account | 0.808 | 0.35 | 485 | 584 |
| 12 | delete_account | ok | groq | delete_account | 0.883 | 0.32 | 370 | 474 |
| 13 | delivery_options | ok | groq | delivery_options | 0.667 | 0.22 | 507 | 634 |
| 14 | delivery_period | ok | extractive | delivery_period | 0.8 | 0.6 | 252 | 2428 |
| 15 | edit_account | ok | groq | edit_account | 0.633 | 0.26 | 381 | 439 |
| 16 | get_invoice | fallback | extractive | get_invoice | 0.477 | 0.35 | 405 | 4348 |
| 17 | get_refund | ok | extractive | get_refund | 0.875 | 0.58 | 252 | 3832 |
| 18 | newsletter_subscription | ok | extractive | newsletter_subscription | 0.9 | 0.33 | 253 | 3881 |
| 19 | payment_issue | ok | groq | payment_issue | 0.836 | 0.37 | 648 | 743 |
| 20 | place_order | ok | extractive | place_order | 0.75 | 0.33 | 252 | 3560 |
| 21 | recover_password | ok | extractive | recover_password | 0.833 | 0.5 | 252 | 4126 |
| 22 | registration_problems | ok | groq | registration_problems | 0.765 | 0.26 | 696 | 776 |
| 23 | review | refused | none | — | 0.625 | 0.2 | 0 | 0 |
| 24 | set_up_shipping_address | ok | extractive | set_up_shipping_address | 1 | 0.57 | 254 | 5472 |
| 25 | switch_account | ok | groq | switch_account | 0.864 | 0.45 | 594 | 762 |
| 26 | track_order | ok | extractive | track_order | 1 | 0.53 | 253 | 3249 |
| 27 | track_refund | ok | groq | track_refund | 0.817 | 0.47 | 359 | 432 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 1 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 1 |
| oos | (refuse) | refused | none | — | 0.583 | — | 0 | 0 |

### Config B — routing OFF (always real model)

| # | expected | outcome | backend | intent | conf | R1 | ttfb | total |
|---|---|---|---|---|---|---|---|---|
| 1 | cancel_order | fallback | extractive | cancel_order | 0.917 | 0.76 | 339 | 6978 |
| 2 | change_order | ok | groq | change_order | 0.787 | 0.3 | 646 | 701 |
| 3 | change_shipping_address | fallback | extractive | change_shipping_address | 0.7 | 0.63 | 371 | 1836 |
| 4 | check_cancellation_fee | fallback | extractive | check_cancellation_fee | 0.845 | 0.36 | 344 | 1577 |
| 5 | check_invoice | fallback | extractive | check_invoice | 0.777 | 0.44 | 502 | 3789 |
| 6 | check_payment_methods | ok | groq | check_payment_methods | 0.759 | 0.32 | 467 | 546 |
| 7 | check_refund_policy | fallback | extractive | check_refund_policy | 0.728 | 0.66 | 385 | 9846 |
| 8 | complaint | refused | none | — | 0.6 | 0.13 | 0 | 1 |
| 9 | contact_customer_service | ok | groq | contact_customer_service | 0.917 | 0.53 | 606 | 713 |
| 10 | contact_human_agent | refused | none | — | 0.451 | 0.23 | 0 | 0 |
| 11 | create_account | ok | groq | create_account | 0.833 | 0.4 | 511 | 612 |
| 12 | delete_account | fallback | extractive | delete_account | 0.816 | 0.55 | 345 | 4306 |
| 13 | delivery_options | fallback | extractive | check_payment_methods | 0.666 | 0.41 | 404 | 6370 |
| 14 | delivery_period | ok | groq | delivery_period | 0.875 | 0.53 | 435 | 500 |
| 15 | edit_account | fallback | extractive | edit_account | 0.633 | 0.33 | 387 | 3346 |
| 16 | get_invoice | ok | groq | get_invoice | 0.714 | 0.27 | 359 | 423 |
| 17 | get_refund | fallback | extractive | get_refund | 0.875 | 0.58 | 341 | 3906 |
| 18 | newsletter_subscription | ok | groq | newsletter_subscription | 0.9 | 0.31 | 496 | 557 |
| 19 | payment_issue | fallback | extractive | payment_issue | 0.672 | 0.66 | 339 | 3284 |
| 20 | place_order | fallback | extractive | place_order | 0.75 | 0.33 | 338 | 3613 |
| 21 | recover_password | fallback | extractive | recover_password | 0.833 | 0.5 | 343 | 4200 |
| 22 | registration_problems | ok | groq | registration_problems | 0.765 | 0.4 | 517 | 691 |
| 23 | review | refused | none | — | 0.625 | 0.2 | 0 | 0 |
| 24 | set_up_shipping_address | fallback | extractive | set_up_shipping_address | 1 | 0.57 | 339 | 5552 |
| 25 | switch_account | ok | groq | switch_account | 0.864 | 0.43 | 590 | 688 |
| 26 | track_order | fallback | extractive | track_order | 1 | 0.53 | 345 | 3341 |
| 27 | track_refund | ok | groq | track_refund | 0.817 | 0.46 | 535 | 654 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 1 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 0 |
| oos | (refuse) | refused | none | — | 0.583 | — | 0 | 0 |
