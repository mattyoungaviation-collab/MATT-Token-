# Threat model and privileged trust

Protections include reentrancy guards, exact payments, balance-delta accounting, zeroed per-swap approvals, fixed routes, a positive active-liquidity floor, EIP-712 replay protection, both daily counters, dense-index repair, one VRF request/seed, rejection sampling, claim state before interaction, and one terminal status per DCA slot. Missing/stale oracle rejection, harmonic-liquidity and deviation checks apply only when the historical-reference window is nonzero.

Economic risk remains: thin liquidity, sustained TWAP manipulation, impact, MEV, token/pool changes, DEX failure and volatility. A one-hour TWAP is not a guarantee. Production liquidity floors must come from fork simulations of both ticket sales and expected hourly buys.

Identity risk remains: Discord accounts are not humans; account sales, collusion and off-platform evasion are possible. IP/wallet heuristics are review signals only. Raw Discord IDs/evidence stay private.

Privileged risk is explicit: the multisig and emergency admin can EACH independently upgrade both proxies during any phase and change active logic. The emergency wallet bypasses the 2-of-3 threshold. Its compromise can put all contract-held funds and prize/refund obligations at risk through an upgrade. Ordinary methods retain accounting, beneficiary and frozen-winner restrictions, but an arbitrary upgrade can supersede them. Neither administrator has a timelock or phase restriction. Reviewer-only wallets flag only; identity signer signs vouchers only; keeper terminal-failure authority cannot redirect funds. The emergency wallet also has review and all administrative powers. It does not gain control of assets already held inside the separate multisig or ownership of another wallet's NFT.

The manually delivered NFT remains in owner custody on Ethereum, not enforceable Ronin escrow. Its owner could move or withhold it; a reported transaction hash alone is not delivery. The API checks the canonical Ethereum receipt and exact assigned recipient. Cross-chain verification still trusts the configured RPC and confirmation policy. Safe NFT deposits into the manager are rejected; unsafe direct transfers must never be used.

ERC-721 transfer compatibility, token behavior, pool type/factory/fee, router ABI, observation history, VRF fees and callback gas are blockers until verified. Tests and source verification are not an audit.

# Spot-only execution option (2026-10-13)

An authorized zero-second guard window uses the pool's current spot tick instead of historical observations. This avoids an `OLD` oracle-history checkout failure but permits a manipulated spot price to set the minimum output. The fixed route, nonzero output floor and active-liquidity check do not prevent sandwiching, MEV or cumulative price collapse. In a pinned local fork, 850 ticket-sized sales passed while output dropped from 19.0615 to 0.06095 RON; this is a financial risk, not a passing economic acceptance test. Do not advertise spot-only as safe or describe a passed individual swap as proof of a viable 1,000-ticket round.
