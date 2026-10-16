# Concise participant terms

- One ticket costs 35 RON + 700,000 MATT, plus gas. Approval may be separate. Failed transactions can still cost gas.
- Sales have no deadline. The draw waits for 1,000 eligible tickets, review, frozen snapshot and accepted Ronin VRF seed.
- Each verified Discord account and linked wallet may buy three successful tickets per UTC day across rounds. OAuth proves an account, not a unique person. Refund does not restore allowance.
- Tickets stay in all six draws. Repeats are allowed. With `k` tickets, per-draw odds are `k/1,000`; at least one is `1-(1-k/1,000)^6` under independently derived streams.
- Disqualified/cancelled ticket refund is the original 35 RON plus 700,000 MATT. Both assets stay owed until a successful claim; claims do not expire. Gas is not refunded.
- Five fixed RON prizes are drawn smallest to largest, then #1358. Dollar/NFT values are estimates, not guarantees.
- The multisig manually initiates the five RON awards from reserved contract funds; failed delivery leaves the RON claim backed. The NFT stays with the owner on Ethereum and is manually sent to its assigned winner. It is not in raffle escrow; delivery depends on the owner. A reported NFT hash is not verified payment until its Ethereum receipt passes the public checks.
- Ticket MATT is held in the raffle contract, not sold by DYNO. After settlement, eligible-ticket MATT becomes a claim for the multisig. Refund MATT remains separately owed to the original ticket holders. The multisig may later trade its own tokens outside the raffle, but no trade or price outcome is promised.
- This version has no funded or scheduled buyback. A separate RON budget and a newly reviewed mechanism would be required to add one.
- The multisig AND activated emergency admin each have immediate upgrades without timelock, including active phases. Emergency wallet `0x1DAb596D0121C250a24B00137E84170FA6874be6` can act alone, bypassing the 2-of-3 multisig. An upgrade can change active logic and threaten contract-held funds, including unpaid obligations. Logic is not immutable. No profit, stability or resale value is promised.
