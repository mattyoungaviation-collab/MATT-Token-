# MATT Gift Boxes

## Ronin mainnet deployment

The gift-box contracts were deployed to Ronin mainnet (chain ID `2020`) on
July 28, 2026.

| Component | Address |
| --- | --- |
| MATT token | `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d` |
| MATT Gift Box Vault | `0x896862e8D9c8576fcb4418ba21b4F9033E7785f4` |
| MATT Gift Boxes | `0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE` |
| Ronin VRF Coordinator | `0x16A62a921e7fEC5Bf867fF5c805b662Db757B778` |
| Owner and RON treasury | `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984` |

### Deployment transactions

| Action | Transaction | Block |
| --- | --- | --- |
| Deploy vault | [`0x94010152...e925c`](https://explorer.roninchain.com/tx/0x94010152b6568e0cbd8f7fa63d46bf24605d20d0a1d76e1faf0e280fa58e925c) | `58907552` |
| Deploy gift boxes | [`0x40366f16...ed477`](https://explorer.roninchain.com/tx/0x40366f162114858368012b300f8e69ea0c4acb47cba3493a643c64fab51ed477) | `58907558` |
| Set vault controller | [`0xf987e624...97102`](https://explorer.roninchain.com/tx/0xf987e62478194ef7dc3d514f521f3d9643cd3950ac020cd0f0f37e616e597102) | See explorer |

### Initial verified state

- Owner: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
- Vault controller: `0x0F4b0637D60Af8e3dfE8aF8d7C9448d34a969EcE`
- Active configuration version: `1`
- Gift boxes: paused
- Vault: unfunded
- Live purchases: disabled

The contracts must remain paused until the source is verified on the explorer,
the MATT vault and RON randomness reserve are deliberately funded, the signed
quote service is configured, and a controlled end-to-end test is complete.

## Published reward configuration

| MATT payout | Probability |
| ---: | ---: |
| 0.85x | 40.0% |
| 0.90x | 20.0% |
| 0.95x | 15.0% |
| 1.00x | 15.0% |
| 1.10x | 5.0% |
| 1.25x | 2.5% |
| 1.50x | 1.5% |
| 2.00x | 0.5% |
| 3.00x | 0.2% |
| 7.50x | 0.3% |

The expected payout is `95.975%`. Available box prices are `100`, `250`, and
`500` RON.

## Audited source hashes

| Source file | SHA-256 |
| --- | --- |
| `contracts/MattGiftBoxVault.sol` | `BADBC72A96E0E3299E97A244E86D1041B8D0D551DE7C7D43EB12EDBC56E33676` |
| `contracts/MattGiftBoxes.sol` | `89325CC47E94BC5507C639EF0C9EF9B010A6B07414C09C8895F3EA3FF93206A4` |
