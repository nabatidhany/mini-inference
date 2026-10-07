# Evaluation results

Held-out set: 30 cases (27 in-scope, 1 per intent, + 3 crafted out-of-scope) from the Bitext customer-support dataset — never used for threshold calibration (that used the dev split, see src/scripts/calibrate.ts).

Two configurations:
- **A — routing ON**: retrieval dominance >= 0.75 short-circuits to the extractive backend (verbatim KB answer, zero cost).
- **B — routing OFF**: every request is synthesized by the real model (`openai/gpt-oss-20b`).

Answer quality method: token-level ROUGE-1 / ROUGE-L F1 against the ground-truth response plus an LLM judge (1-5, sample of 15 answered cases) — the judge calls the provider directly, outside the metered gateway path.

| metric | A: routing ON (short-circuit 0.75) | B: routing OFF (always real model) |
|---|---|---|
| intent accuracy (27 in-scope) | 88.9% | 88.9% |
| retrieval-vote intent accuracy (groq cases) | 91.7% | 95.5% |
| LLM-reported intent accuracy (groq cases) | 100% | 100% |
| answer ROUGE-1 F1 | 0.404 | 0.363 |
| answer ROUGE-L F1 | 0.278 | 0.250 |
| refusal accuracy (3 out-of-scope) | 100% | 100% |
| in-scope refusal rate | 11.1% | 11.1% |
| TTFB p50 / p95 (ms) | 253 / 752 | 528 / 830 |
| total latency p50 / p95 (ms) | 734 / 5200 | 587 / 948 |
| tokens in / out (metered) | 13064 / 1329 | 22483 / 2227 |
| metered cost (USD) | $0.001379 | $0.002353 |
| route rules | short_circuit:10, default:14, no_evidence_refusal:6 | default:24, no_evidence_refusal:6 |
| outcomes | ok:24, refused:6 | ok:24, refused:6 |

## Notes

- Latency percentiles are client-measured (the eval script is the client).
- Tokens/cost come from the gateway metering (provider-reported on the groq path, chars/4 estimated on the extractive path).
- Out-of-scope refusal accuracy: correct behaviour is refusing (coverage gate), not guessing.

## Raw results per case

### Config A — routing ON (short-circuit 0.75)

| # | expected | outcome | backend | intent | conf | R1 | ttfb | total |
|---|---|---|---|---|---|---|---|---|
| 1 | cancel_order | ok | extractive | cancel_order | 0.917 | 0.76 | 252 | 6546 |
| 2 | change_order | ok | groq | change_order | 0.787 | 0.18 | 392 | 442 |
| 3 | change_shipping_address | ok | extractive | change_shipping_address | 0.7 | 0.63 | 251 | 1641 |
| 4 | check_cancellation_fee | ok | groq | check_cancellation_fee | 0.897 | 0.45 | 677 | 740 |
| 5 | check_invoice | ok | groq | check_invoice | 0.864 | 0.4 | 621 | 728 |
| 6 | check_payment_methods | ok | groq | check_payment_methods | 0.784 | 0.29 | 513 | 600 |
| 7 | check_refund_policy | ok | groq | check_refund_policy | 0.839 | 0.29 | 615 | 827 |
| 8 | complaint | refused | none | — | 0.6 | 0.13 | 0 | 1 |
| 9 | contact_customer_service | ok | extractive | contact_customer_service | 0.833 | 0.63 | 252 | 2468 |
| 10 | contact_human_agent | refused | none | — | 0.451 | 0.23 | 0 | 1 |
| 11 | create_account | ok | groq | create_account | 0.808 | 0.4 | 640 | 734 |
| 12 | delete_account | ok | groq | delete_account | 0.883 | 0.32 | 513 | 599 |
| 13 | delivery_options | ok | groq | delivery_options | 0.667 | 0.21 | 668 | 772 |
| 14 | delivery_period | ok | extractive | delivery_period | 0.8 | 0.6 | 253 | 2316 |
| 15 | edit_account | ok | groq | edit_account | 0.633 | 0.31 | 802 | 805 |
| 16 | get_invoice | ok | groq | get_invoice | 0.714 | 0.36 | 522 | 641 |
| 17 | get_refund | ok | extractive | get_refund | 0.875 | 0.58 | 252 | 3626 |
| 18 | newsletter_subscription | ok | extractive | newsletter_subscription | 0.9 | 0.33 | 253 | 3693 |
| 19 | payment_issue | ok | groq | payment_issue | 0.836 | 0.31 | 707 | 711 |
| 20 | place_order | ok | extractive | place_order | 0.75 | 0.33 | 251 | 3372 |
| 21 | recover_password | ok | extractive | recover_password | 0.833 | 0.5 | 253 | 3918 |
| 22 | registration_problems | ok | groq | registration_problems | 0.765 | 0.24 | 588 | 677 |
| 23 | review | refused | none | — | 0.625 | 0.2 | 0 | 1 |
| 24 | set_up_shipping_address | ok | extractive | set_up_shipping_address | 1 | 0.57 | 252 | 5200 |
| 25 | switch_account | ok | groq | switch_account | 0.889 | 0.4 | 523 | 605 |
| 26 | track_order | ok | extractive | track_order | 1 | 0.53 | 253 | 3089 |
| 27 | track_refund | ok | groq | track_refund | 0.684 | 0.09 | 752 | 775 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 1 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 2 |
| oos | (refuse) | refused | none | — | 0.583 | — | 0 | 1 |

### Config B — routing OFF (always real model)

| # | expected | outcome | backend | intent | conf | R1 | ttfb | total |
|---|---|---|---|---|---|---|---|---|
| 1 | cancel_order | ok | groq | cancel_order | 0.958 | 0.36 | 595 | 665 |
| 2 | change_order | ok | groq | change_order | 0.787 | 0.22 | 681 | 712 |
| 3 | change_shipping_address | ok | groq | change_shipping_address | 0.7 | 0.39 | 474 | 511 |
| 4 | check_cancellation_fee | ok | groq | check_cancellation_fee | 0.897 | 0.45 | 683 | 752 |
| 5 | check_invoice | ok | groq | check_invoice | 0.864 | 0.43 | 417 | 504 |
| 6 | check_payment_methods | ok | groq | check_payment_methods | 0.784 | 0.29 | 523 | 587 |
| 7 | check_refund_policy | ok | groq | check_refund_policy | 0.839 | 0.33 | 777 | 883 |
| 8 | complaint | refused | none | — | 0.6 | 0.13 | 0 | 1 |
| 9 | contact_customer_service | ok | groq | contact_customer_service | 0.917 | 0.52 | 743 | 899 |
| 10 | contact_human_agent | refused | none | — | 0.451 | 0.23 | 0 | 1 |
| 11 | create_account | ok | groq | create_account | 0.833 | 0.38 | 584 | 708 |
| 12 | delete_account | ok | groq | delete_account | 0.883 | 0.31 | 659 | 758 |
| 13 | delivery_options | ok | groq | delivery_options | 0.667 | 0.2 | 610 | 671 |
| 14 | delivery_period | ok | groq | delivery_period | 0.875 | 0.5 | 502 | 562 |
| 15 | edit_account | ok | groq | edit_account | 0.633 | 0.31 | 603 | 652 |
| 16 | get_invoice | ok | groq | get_invoice | 0.714 | 0.29 | 501 | 545 |
| 17 | get_refund | ok | groq | get_refund | 0.912 | 0.33 | 506 | 564 |
| 18 | newsletter_subscription | ok | groq | newsletter_subscription | 0.925 | 0.32 | 1021 | 1075 |
| 19 | payment_issue | ok | groq | payment_issue | 0.836 | 0.5 | 338 | 504 |
| 20 | place_order | ok | groq | place_order | 0.85 | 0.32 | 639 | 689 |
| 21 | recover_password | ok | groq | recover_password | 0.892 | 0.39 | 707 | 845 |
| 22 | registration_problems | ok | groq | registration_problems | 0.765 | 0.24 | 830 | 948 |
| 23 | review | refused | none | — | 0.625 | 0.2 | 0 | 1 |
| 24 | set_up_shipping_address | ok | groq | set_up_shipping_address | 1 | 0.4 | 716 | 751 |
| 25 | switch_account | ok | groq | switch_account | 0.889 | 0.41 | 421 | 548 |
| 26 | track_order | ok | groq | track_order | 0.975 | 0.36 | 608 | 633 |
| 27 | track_refund | ok | groq | track_refund | 0.817 | 0.47 | 528 | 562 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 1 |
| oos | (refuse) | refused | none | — | 0 | — | 0 | 2 |
| oos | (refuse) | refused | none | — | 0.583 | — | 0 | 2 |
