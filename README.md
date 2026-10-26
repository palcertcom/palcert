# PalCert source import — completed 2026-10-26

Source was imported into `palcertcom/palcert` from the owner's verified offline handover. The newest complete code, including SmartFix, institution service revenue sharing, and financial/service reports with print/PDF exports, is on [feat/institution-service-revenue](https://github.com/palcertcom/palcert/tree/feat/institution-service-revenue).

This repository uses new snapshot commits. It does not preserve the old GitHub commit IDs, PR numbers, reviews, or CI results. Feature branches remain separate from main. No feature merge, release, or production deployment was performed.

## Published snapshots

Each commit, parent relationship, and root tree below was read back from GitHub and matched against locally computed trees.

| Branch | Published commit | Published tree | Files |
| --- | --- | --- | --- |
| main | 415e2a5d57bc45a3b9364c025730bf8b8b208e33 | a48e05b86eaa8651985d65ee0d851a073eb82e5d | 1775 |
| fix/docx-theme-font-coverage | 281c8b9c1d98755cfa438c44e3d34dce025a8a39 | 982a92dce34cf9953313bd0ad04110a399e43b21 | 1800 |
| feat/institution-service-revenue | d4983bc4898b72bc097fe865865abcc6fed509b8 | f9a94cbe34575a7582cfff7c58cdd8b7f2b53a8c | 1830 |

The parent chain is the provenance root `4414be748c0a614b50f9f6bb5830b8231a271a73`, then main, SmartFix, and institution revenue/reporting in that order.

## Handover provenance

The verified standalone history bundle remains in the owner's handover package: 334 reconstructed commits and 16 branches. Its SHA-256 is `d53b0412e972fdf1b5f5ffb36cb2d1fb7a9bbd8746259dac138e10f506630644`. That reconstructed history was not pushed into the old repository or imported as native history here.

| Snapshot | Original commit | Reconstructed handover commit | Original tree |
| --- | --- | --- | --- |
| Main baseline | 03b2d2cce4f8f485b575b5a8c0e1fa5668c47bcc | d9cd1cac556a2c201ddad1ff9e75aa80b5e9c8e5 | ea907445fd1de8e487e5f04d1f02214b43d6de0b |
| SmartFix | ff3b1179c6c8afdac6bd7f47c51a7ff5f1451be7 | 7140bf929b67271066865da370b61bfa2fd0d3ce | fefb4907614c85ef4c550e95ae953ffcfd405004 |
| Institution revenue and reports | f6b813a656be78e77b6ab38a3a06bd138cbf3b92 | 37a3f1f0eec473682d562460f4a0ab4126607ca7 | 52b04905f1bd09cbfe31704af6ab0ac0accf5df3 |

## One reviewed fixture change

GitHub secret protection rejected a credential-shaped planted test value in `packages/config/src/load-env.spec.ts`. The dummy was replaced with the clearly invalid string `sk_live_not_a_real_key` and an explanatory comment. Protection was not bypassed or disabled.

The tests still require a configuration error for the invalid `API_DOCS_ENABLED` value and still assert that the error does not echo the planted value. No assertion, runtime code, deadline, or security setting changed.

This is the only changed file relative to each original snapshot. Every other file's contents and executable bits match the handover. The original blob was `3d998e603d2442a1890938f96102e3e9eb31dc9e`; the replacement is `dd1a91ec589f81bc8d1c388a4d48b4057a58ed20`.

Validation after the change:
- All 55 tests in `packages/config/src/load-env.spec.ts` passed.
- The config package typecheck and scoped Prettier check passed.
- Diff checks passed for all three snapshots.
- All seven imported binary blobs matched their original Git blob hashes.

Gitleaks 8.30.1 scanned all 334 reconstructed commits, including merges. The 19 findings were reviewed as planted test values, internal URLs, or explicit ephemeral CI/local development values. No live credential was identified in these findings. This does not guarantee detection of every possible secret.

## CI and deployment status

The branch publications automatically created CI runs; no duplicate run was manually dispatched:
- [Main](https://github.com/palcertcom/palcert/actions/runs/40288476256)
- [SmartFix](https://github.com/palcertcom/palcert/actions/runs/40288475736)
- [Institution revenue and reports](https://github.com/palcertcom/palcert/actions/runs/40288477232)

All three were queued at the import verification. Those results must be checked live; previous local or old-repository results do not prove these new heads passed CI. Required exact-head checks, final reviews, ordered feature merges, and Release gates remain outstanding. Production was not accessed or changed.
