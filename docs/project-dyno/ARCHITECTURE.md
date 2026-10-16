# Architecture and state model

`ProjectDynoRaffleManager` and `ProjectDynoBuybackVault` are UUPS implementations behind ERC-1967 proxies. Implementations lock initialization; deployments supply initialization calldata atomically. The multisig and configured emergency admin each have immediate unilateral upgrade authority. The vault derives emergency authority from the manager; the real price guard binds to that same manager. The vault grants keepers only terminal-failure authority; successful current-slot execution is public.

Raffle phases are `DRAFT → OPEN → REVIEW → FROZEN → RANDOMNESS_PENDING → RANDOMNESS_READY → WINNERS_ASSIGNED → SETTLED`. Disqualification makes `REVIEW → OPEN`. `CANCELLED` is reachable through `FROZEN`, never after requesting randomness. Claims coexist with final phases.

Ticket history is append-only. A dense eligible-ID array supports swap-and-pop before freeze. Freeze hashes each `(priorDigest,index,ticketId)` in index order. Anyone can read each index and reproduce the digest. Six candidate streams bind seed, chain ID, proxy, round, prize index and rejection counter; selection is unbiased and with replacement.

The API holds encrypted private Discord identity observations and signs scoped EIP-712 vouchers; it cannot create tickets. Owner-selected storage is SQLite on `/var/data/project-dyno/dyno.sqlite`. The same service instance hosts the API and optional read-only indexer. SQLite is a reorg-aware index plus private authentication storage, not the financial ledger. Legacy PostgreSQL indexing remains an alternative adapter, not the selected production deployment. The keeper has gas only and cannot select seed, amount, route, beneficiary or winner.

Prize delivery is manual by owner revision. The multisig initiates five fixed-recipient RON payments from contract-reserved liabilities. The owner separately sends the Ethereum NFT to its original winning wallet; an on-chain hash report is evidence only, independently verified against its Ethereum receipt. The keeper never schedules prize transfers. See [manual prize workflow](MANUAL-PRIZES.md).

The vault fixes `B`, `floor(B/168)`, dust, treasury and `t0`. Slot `i` exists only in `[t0+i×3600,t0+(i+1)×3600)`. Public failure reverts without consuming it. Keeper/admin execution catches an isolated self-call failure and records `FAILED`. Elapsed untouched slots become `MISSED`; close returns `B-successfulSpend`.
# Current no-sale revision

The fixed two-token ticket now holds MATT instead of selling it. The legacy buyback vault and Katana modules described below are inactive for the current payment model. See [NO-SALE-REVISION.md](NO-SALE-REVISION.md).

