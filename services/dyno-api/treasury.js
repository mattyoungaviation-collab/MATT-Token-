"use strict";

const { Contract, Interface, getAddress, ZeroAddress } = require("ethers");
const { id, PHASES } = require("./public-state");

// Existing claims release the recorded treasury allocation, never arbitrary amounts.
const CLAIMS = new Interface([
  "function claimTreasuryLiability(uint256 roundId)",
  "function claimTreasuryMatt(uint256 roundId)",
]);
const ERC20 = ["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"];
const SAFE = ["function getThreshold() view returns(uint256)"];
const MAX_ROUNDS = 64;
const integer = value => {
  if (typeof value !== "bigint" || value < 0n) throw new Error("TREASURY_CHAIN_DATA_INVALID");
  return value;
};

async function readTreasuryAt({ provider, manager, manifest, roundId, at }) {
  roundId = id(roundId);
  if (manifest.mock || manifest.paymentModel !== "RON_AND_HELD_MATT") throw new Error("TREASURY_UNAVAILABLE");
  const target = getAddress(manifest.raffleProxy), executor = getAddress(manifest.multisig);
  const matt = getAddress(manifest.matt);
  if ([target, executor, matt].includes(ZeroAddress)) throw new Error("TREASURY_CHAIN_DATA_INVALID");
  const next = integer(await manager.nextRoundId(at));
  if (next <= BigInt(roundId)) throw new Error("TREASURY_ROUND_NOT_FOUND");
  // Fail closed rather than ignore older refunds or perform an unbounded RPC scan.
  if (next - 1n > BigInt(MAX_ROUNDS)) throw new Error("TREASURY_ROUND_LIMIT");
  let ronReserved = 0n, mattReserved = 0n, selected;
  for (let start = 1n; start < next; start += 4n) {
    const ids = Array.from({ length: Number(next - start > 4n ? 4n : next - start) }, (_, i) => start + BigInt(i));
    const rows = await Promise.all(ids.map(async current => {
      const [status, terms, active, refundable, treasury] = await Promise.all([
        manager.getRoundStatus(current, at), manager.getRoundTerms(current, at),
        manager.mattActive(current, at), manager.mattRefundLiability(current, at),
        manager.treasuryMattLiability(current, at),
      ]);
      const phase = Number(status.phase);
      if (!Number.isInteger(phase) || phase < 1 || !PHASES[phase]) throw new Error("TREASURY_CHAIN_DATA_INVALID");
      for (const key of ["directActive", "saleActive", "operationsBalance", "refundLiability", "prizeLiability", "treasuryLiability"]) integer(status[key]);
      integer(active); integer(refundable); integer(treasury);
      return { current, status, terms, active, refundable, treasury, phase };
    }));
    for (const row of rows) {
      const r = row.status;
      ronReserved += r.directActive + r.saleActive + r.operationsBalance + r.refundLiability + r.prizeLiability + r.treasuryLiability;
      if (getAddress(row.terms.matt) === matt) mattReserved += row.active + row.refundable + row.treasury;
      if (row.current === BigInt(roundId)) selected = row;
    }
  }
  if (!selected || getAddress(selected.terms.matt) !== matt) throw new Error("TREASURY_TOKEN_MISMATCH");
  const token = new Contract(matt, ERC20, provider), safe = new Contract(executor, SAFE, provider);
  const [ronBalance, mattBalance, decimals, threshold, safeCode] = await Promise.all([
    provider.getBalance(target, at.blockTag), token.balanceOf(target, at), token.decimals(at),
    safe.getThreshold(at), provider.getCode(executor, at.blockTag),
  ]);
  integer(ronBalance); integer(mattBalance); integer(threshold);
  if (Number(decimals) !== 18 || threshold < 1n || safeCode === "0x") throw new Error("TREASURY_CHAIN_DATA_INVALID");
  const solvent = ronBalance >= ronReserved && mattBalance >= mattReserved;
  const terminal = selected.phase === 8 || selected.phase === 9;
  return {
    chainId: manifest.chainId, roundId, target, executor, token: matt, tokenDecimals: 18,
    phase: PHASES[selected.phase], safeThreshold: threshold.toString(), roundsChecked: (next - 1n).toString(),
    ronBalance: ronBalance.toString(), mattBalance: mattBalance.toString(),
    ronReserved: ronReserved.toString(), mattReserved: mattReserved.toString(), fullyBacked: solvent,
    claimableRon: (solvent && terminal ? selected.status.treasuryLiability : 0n).toString(),
    claimableMatt: (solvent && selected.phase === 8 ? selected.treasury : 0n).toString(),
    note: "Existing treasury allocations only. Active ticket funds, operations, refunds and prizes remain accounted for across all checked rounds. Claims release the full recorded allocation to the configured treasury; Safe execution must still succeed on chain.",
  };
}

async function prepareTreasuryAt({ provider, state, request, block, nowSeconds }) {
  const fields = ["roundId", "asset", "expectedAllocation", "expectedTarget", "expectedExecutor"];
  if (!request || Object.keys(request).some(key => !fields.includes(key)) || !["RON", "MATT"].includes(request.asset) || id(request.roundId) !== state.roundId)
    throw new Error("INVALID_TREASURY_REQUEST");
  const amount = request.asset === "RON" ? state.claimableRon : state.claimableMatt;
  if (!state.fullyBacked || BigInt(amount) === 0n) throw new Error("TREASURY_NOT_CLAIMABLE");
  if (request.expectedAllocation !== amount || request.expectedTarget !== state.target || request.expectedExecutor !== state.executor)
    throw new Error("TREASURY_CHANGED");
  const method = request.asset === "RON" ? "claimTreasuryLiability" : "claimTreasuryMatt";
  const data = CLAIMS.encodeFunctionData(method, [state.roundId]);
  try {
    // These claims are treasury-only, even when the preparer is an emergency admin.
    // A successful simulation also verifies this Safe is the round's actual treasury.
    await provider.send("eth_call", [{ from: state.executor, to: state.target, data, value: "0x0" }, `0x${block.number.toString(16)}`]);
  } catch { throw new Error("TREASURY_SIMULATION_FAILED"); }
  return {
    ...state, asset: request.asset, observedAllocation: amount, method, data, value: "0",
    executionMode: "multisig", executionFrom: state.executor, simulated: true, submitted: false,
    preparedAt: nowSeconds, reviewBy: nowSeconds + 120,
    meaning: "Unsigned treasury claim only. Recheck the full allocation and Safe beneficiary before executing. This is not an arbitrary transfer or a partial withdrawal.",
  };
}

module.exports = { readTreasuryAt, prepareTreasuryAt, CLAIMS, MAX_ROUNDS };
