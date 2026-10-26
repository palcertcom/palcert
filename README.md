# PalCert source import

This new repository is being populated from the offline handover supplied on 2026-10-26. It uses new snapshot commits; it does not claim to preserve the original GitHub commit history or PR state.

The verified standalone history bundle remains available in the owner's handover package (334 reconstructed commits, 16 branches). Its SHA-256 is `d53b0412e972fdf1b5f5ffb36cb2d1fb7a9bbd8746259dac138e10f506630644`.

The import will preserve the exact source trees and executable bits for the base main, SmartFix, and institution revenue/reporting snapshots. Feature branches remain separate from main. No merge, release, CI success, or production deployment is implied by this import.

| Snapshot | Original commit | Reconstructed handover commit | Exact tree |
| --- | --- | --- | --- |
| Main baseline | 03b2d2cce4f8f485b575b5a8c0e1fa5668c47bcc | d9cd1cac556a2c201ddad1ff9e75aa80b5e9c8e5 | ea907445fd1de8e487e5f04d1f02214b43d6de0b |
| SmartFix | ff3b1179c6c8afdac6bd7f47c51a7ff5f1451be7 | 7140bf929b67271066865da370b61bfa2fd0d3ce | fefb4907614c85ef4c550e95ae953ffcfd405004 |
| Institution revenue and reports | f6b813a656be78e77b6ab38a3a06bd138cbf3b92 | 37a3f1f0eec473682d562460f4a0ab4126607ca7 | 52b04905f1bd09cbfe31704af6ab0ac0accf5df3 |

Gitleaks 8.30.1 scanned all 334 reconstructed commits, including merges. The 19 findings were reviewed as planted test values, internal URLs, or explicit ephemeral CI/local development values. No live credential was identified in these findings. This is not a guarantee that every possible secret can be detected.
