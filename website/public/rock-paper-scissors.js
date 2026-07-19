(() => {
  "use strict";

  const CHAIN_ID = 2020;
  const CHAIN_HEX = "0x7e4";
  const RPC_URL = "https://api.roninchain.com/rpc";
  const MATT_ADDRESS = "0xa5450417BDCa0BDfB058ffE41205400FfDA1174d";
  const RPS_ADDRESS = "0x0DaFC8bF9fda516F4576Dd609DAA18A5CB0E29E5";
  const WAGER = ethers.parseEther("25000");
  const ZERO = ethers.ZeroAddress;

  const RPS_ABI = [
    "event GameCreated(uint256 indexed gameId,address indexed creator,uint256 wager)",
    "function createGame() returns (uint256)",
    "function cancelOpenGame(uint256 gameId)",
    "function acceptGame(uint256 gameId)",
    "function fundGame(uint256 gameId)",
    "function commitMove(uint256 gameId,bytes32 commitment)",
    "function revealMove(uint256 gameId,uint8 move,bytes32 salt)",
    "function claimFundingTimeout(uint256 gameId)",
    "function claimCommitTimeout(uint256 gameId)",
    "function claimRevealTimeout(uint256 gameId)",
    "function makeCommitment(uint256 gameId,uint8 round,address player,uint8 move,bytes32 salt) view returns(bytes32)",
    "function getGame(uint256 gameId) view returns(tuple(address creator,address opponent,uint8 status,uint8 round,uint64 deadline,bool creatorFunded,bool opponentFunded,bytes32 creatorCommitment,bytes32 opponentCommitment,uint8 creatorMove,uint8 opponentMove,bool creatorRevealed,bool opponentRevealed,address winner))",
    "function nextGameId() view returns(uint256)",
    "function paused() view returns(bool)"
  ];
  const TOKEN_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)"
  ];

  const STATUS = ["NONE","OPEN","FUNDING","COMMIT","REVEAL","SETTLED","REFUNDED","CANCELLED"];
  const state = { browserProvider:null, signer:null, account:null, readProvider:null, readRps:null, rps:null, token:null, activeGameId:null, activeGame:null, timer:null };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const validDeployment = ethers.isAddress(RPS_ADDRESS) && RPS_ADDRESS !== ZERO;

  function short(address) { return address && address !== ZERO ? `${address.slice(0,6)}…${address.slice(-4)}` : "Waiting"; }
  function setGlobal(message, error=false) { $("#global-status").textContent = message; $("#global-status").className = `status ${error ? "bad" : ""}`; }
  function setMatch(message, good=false) { $("#match-status").textContent = message; $("#match-status").className = `status ${good ? "good" : ""}`; }
  function storageKey(gameId) { return `mattRpsMove:${CHAIN_ID}:${RPS_ADDRESS}:${gameId}`; }

  async function ensureRonin() {
    const chainId = await window.ethereum.request({ method:"eth_chainId" });
    if (chainId.toLowerCase() === CHAIN_HEX) return;
    try { await window.ethereum.request({ method:"wallet_switchEthereumChain", params:[{chainId:CHAIN_HEX}] }); }
    catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({ method:"wallet_addEthereumChain", params:[{ chainId:CHAIN_HEX, chainName:"Ronin Mainnet", nativeCurrency:{name:"RON",symbol:"RON",decimals:18}, rpcUrls:[RPC_URL], blockExplorerUrls:["https://app.roninchain.com"] }] });
    }
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error("Ronin Wallet or another EVM wallet is required.");
    if (!validDeployment) throw new Error("RPS contract deployment address has not been configured yet.");
    await window.ethereum.request({ method:"eth_requestAccounts" });
    await ensureRonin();
    state.browserProvider = new ethers.BrowserProvider(window.ethereum);
    state.signer = await state.browserProvider.getSigner();
    state.account = await state.signer.getAddress();
    state.rps = new ethers.Contract(RPS_ADDRESS, RPS_ABI, state.signer);
    state.token = new ethers.Contract(MATT_ADDRESS, TOKEN_ABI, state.signer);
    $("#wallet-button").textContent = short(state.account);
    $("#wallet-address").textContent = state.account;
    $("#create-game").disabled = false;
    await refreshBalance();
    await refreshBoard();
    restoreActiveGame();
  }

  async function refreshBalance() {
    if (!state.account) return;
    const balance = await state.token.balanceOf(state.account);
    $("#matt-balance").textContent = `${Number(ethers.formatEther(balance)).toLocaleString(undefined,{maximumFractionDigits:0})} MATT`;
  }

  async function initReadOnly() {
    if (!validDeployment) {
      $("#contract-status").textContent = "Deployment pending";
      $("#waiting-board").innerHTML = '<p class="empty">The RPS contract is not configured.</p>';
      return;
    }
    state.readProvider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    state.readRps = new ethers.Contract(RPS_ADDRESS, RPS_ABI, state.readProvider);
    const code = await state.readProvider.getCode(RPS_ADDRESS);
    if (code === "0x") throw new Error("No RPS contract found at the configured address.");
    $("#contract-status").textContent = "Live on Ronin";
    await refreshBoard();
  }

  async function createGame() {
    const tx = await state.rps.createGame();
    setGlobal(`Creating game: ${tx.hash}`);
    const receipt = await tx.wait(1);
    const parsed = receipt.logs.map(log => { try{return state.rps.interface.parseLog(log);}catch{return null;} }).find(log => log?.name === "GameCreated");
    if (!parsed) throw new Error("GameCreated event was not found.");
    state.activeGameId = Number(parsed.args.gameId);
    localStorage.setItem("mattRpsActiveGame", String(state.activeGameId));
    await loadActiveGame();
    await refreshBoard();
  }

  async function acceptGame(gameId) {
    requireWallet();
    const tx = await state.rps.acceptGame(gameId);
    setGlobal(`Accepting game #${gameId}: ${tx.hash}`);
    await tx.wait(1);
    state.activeGameId = Number(gameId);
    localStorage.setItem("mattRpsActiveGame", String(gameId));
    await loadActiveGame();
    await refreshBoard();
  }

  async function fundGame() {
    requireWallet();
    let allowance = await state.token.allowance(state.account, RPS_ADDRESS);
    if (allowance < WAGER) {
      setMatch("Approve 25,000 MATT in your wallet.");
      const approval = await state.token.approve(RPS_ADDRESS, WAGER);
      await approval.wait(1);
      allowance = await state.token.allowance(state.account, RPS_ADDRESS);
      if (allowance < WAGER) throw new Error("MATT approval was not confirmed.");
    }
    setMatch("Confirm the 25,000 MATT escrow deposit.");
    const tx = await state.rps.fundGame(state.activeGameId);
    await tx.wait(1);
    await refreshBalance();
    await loadActiveGame();
  }

  async function chooseMove(move) {
    requireWallet();
    const game = state.activeGame;
    const salt = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    const commitment = await state.rps.makeCommitment(state.activeGameId, game.round, state.account, move, salt);
    localStorage.setItem(storageKey(state.activeGameId), JSON.stringify({ round:Number(game.round), move:Number(move), salt }));
    $$(".moves button").forEach(button => button.disabled = true);
    setMatch("Confirm your hidden move commitment in the wallet.");
    try {
      const tx = await state.rps.commitMove(state.activeGameId, commitment);
      await tx.wait(1);
      await loadActiveGame();
    } catch (error) {
      localStorage.removeItem(storageKey(state.activeGameId));
      throw error;
    } finally {
      $$(".moves button").forEach(button => button.disabled = false);
    }
  }

  async function revealMove() {
    requireWallet();
    const saved = JSON.parse(localStorage.getItem(storageKey(state.activeGameId)) || "null");
    if (!saved || Number(saved.round) !== Number(state.activeGame.round)) throw new Error("This browser no longer has the secret needed to reveal this round.");
    setMatch("Confirm your move reveal in the wallet.");
    const tx = await state.rps.revealMove(state.activeGameId, saved.move, saved.salt);
    await tx.wait(1);
    localStorage.removeItem(storageKey(state.activeGameId));
    await refreshBalance();
    await loadActiveGame();
  }

  async function claimTimeout() {
    const status = Number(state.activeGame.status);
    const method = status === 2 ? "claimFundingTimeout" : status === 3 ? "claimCommitTimeout" : status === 4 ? "claimRevealTimeout" : null;
    if (!method) throw new Error("This game is not in a timeout-settleable stage.");
    const tx = await state.rps[method](state.activeGameId);
    setMatch(`Settling timeout: ${tx.hash}`);
    await tx.wait(1);
    await refreshBalance();
    await loadActiveGame();
  }

  async function refreshBoard() {
    const contract = state.rps || state.readRps;
    if (!contract) return;
    $("#waiting-board").innerHTML = '<p class="empty">Reading open games from Ronin…</p>';
    const next = Number(await contract.nextGameId());
    const ids = [];
    for (let id = Math.max(1,next-60); id < next; id++) ids.push(id);
    const games = await Promise.all(ids.map(async id => { try{return {id,game:await contract.getGame(id)}}catch{return null} }));
    const open = games.filter(item => item && Number(item.game.status) === 1).reverse();
    if (!open.length) { $("#waiting-board").innerHTML = '<p class="empty">No open games. Create the first challenge.</p>'; return; }
    $("#waiting-board").innerHTML = open.map(({id,game}) => `<div class="lobby-game"><div><b>Game #${id} • 25,000 MATT</b><small>Created by ${short(game.creator)}</small></div><button data-accept="${id}" ${state.account && game.creator.toLowerCase()===state.account.toLowerCase()?"disabled":""}>ACCEPT</button></div>`).join("");
    $$('[data-accept]').forEach(button => button.addEventListener("click", () => act(() => acceptGame(Number(button.dataset.accept)))));
  }

  function restoreActiveGame() {
    const saved = Number(localStorage.getItem("mattRpsActiveGame") || 0);
    if (saved > 0) { state.activeGameId = saved; loadActiveGame().catch(error => setMatch(error.message)); }
  }

  async function loadActiveGame() {
    if (!state.rps || !state.activeGameId) return;
    const game = await state.rps.getGame(state.activeGameId);
    state.activeGame = game;
    renderGame(game);
  }

  function isCreator(game) { return state.account && game.creator.toLowerCase() === state.account.toLowerCase(); }
  function isOpponent(game) { return state.account && game.opponent.toLowerCase() === state.account.toLowerCase(); }
  function playerFlag(game, creatorFlag, opponentFlag) { return isCreator(game) ? creatorFlag : isOpponent(game) ? opponentFlag : false; }

  function renderGame(game) {
    const status = Number(game.status);
    $("#game-details").classList.remove("hidden");
    $("#game-title").textContent = `Game #${state.activeGameId} • Round ${game.round}`;
    $("#creator-address").textContent = short(game.creator);
    $("#opponent-address").textContent = short(game.opponent);
    $("#creator-state").textContent = game.creatorFunded ? "Funded" : "Not funded";
    $("#opponent-state").textContent = game.opponentFunded ? "Funded" : "Not funded";
    ["#funding-actions","#move-actions","#reveal-actions","#timeout-actions"].forEach(id => $(id).classList.add("hidden"));

    const now = Math.floor(Date.now()/1000);
    const expired = Number(game.deadline) > 0 && now > Number(game.deadline);
    if (expired && [2,3,4].includes(status)) $("#timeout-actions").classList.remove("hidden");
    else if (status === 2 && !playerFlag(game, game.creatorFunded, game.opponentFunded)) $("#funding-actions").classList.remove("hidden");
    else if (status === 3 && !playerFlag(game, game.creatorCommitment !== ethers.ZeroHash, game.opponentCommitment !== ethers.ZeroHash)) $("#move-actions").classList.remove("hidden");
    else if (status === 4 && !playerFlag(game, game.creatorRevealed, game.opponentRevealed)) $("#reveal-actions").classList.remove("hidden");

    if (status === 1) setMatch("Challenge posted. Waiting for another player to accept.");
    else if (status === 2) setMatch("Both players must fund before the 60-second deadline.");
    else if (status === 3) setMatch("Choose Rock, Paper, or Scissors. Your choice stays secret.");
    else if (status === 4) setMatch("Both choices are locked. Reveal your move.");
    else if (status === 5) { setMatch(`Winner: ${short(game.winner)} • 45,000 MATT paid`, true); clearActiveIfFinished(); }
    else if (status === 6) { setMatch("Game refunded by the contract.", true); clearActiveIfFinished(); }
    else if (status === 7) { setMatch("Game cancelled."); clearActiveIfFinished(); }

    startCountdown(Number(game.deadline));
  }

  function clearActiveIfFinished() { localStorage.removeItem("mattRpsActiveGame"); }
  function startCountdown(deadline) {
    clearInterval(state.timer);
    const draw = () => {
      if (!deadline) { $("#countdown").textContent = STATUS[Number(state.activeGame?.status || 0)]; return; }
      const remaining = Math.max(0, deadline - Math.floor(Date.now()/1000));
      $("#countdown").textContent = `${remaining}s`;
      if (remaining === 0) { clearInterval(state.timer); loadActiveGame().catch(()=>{}); }
    };
    draw(); state.timer = setInterval(draw, 1000);
  }

  function requireWallet() { if (!state.account || !state.rps) throw new Error("Connect your Ronin Wallet first."); }
  function errorMessage(error) { return error?.shortMessage || error?.reason || error?.message || "Transaction failed."; }
  async function act(fn) { try { await fn(); } catch (error) { setGlobal(errorMessage(error), true); setMatch(errorMessage(error)); } }

  $("#wallet-button").addEventListener("click", () => act(connectWallet));
  $("#create-game").addEventListener("click", () => act(createGame));
  $("#refresh-board").addEventListener("click", () => act(refreshBoard));
  $("#fund-game").addEventListener("click", () => act(fundGame));
  $("#reveal-move").addEventListener("click", () => act(revealMove));
  $("#claim-timeout").addEventListener("click", () => act(claimTimeout));
  $$(".moves button").forEach(button => button.addEventListener("click", () => act(() => chooseMove(Number(button.dataset.move)))));

  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
  initReadOnly().catch(error => setGlobal(errorMessage(error), true));
})();
