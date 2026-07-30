// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IKatanaV3Pool} from "./interfaces/IKatanaV3Pool.sol";
import {IMattRewardVault} from "./interfaces/IMattRewardVault.sol";
import {KatanaTwap} from "./libraries/KatanaTwap.sol";

/// @title MATT BurnFlip Universal Wager Edition
/// @notice Accepts supported Ronin assets, forwards every wager to the treasury, and settles only in MATT.
/// @dev Uses a future-block commit/reveal outcome and a fixed-window Katana V3 TWAP recorded at bet placement.
contract MattCoinFlipBurn is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Choice {
        Heads,
        Tails
    }

    enum BetState {
        None,
        Pending,
        Won,
        Lost,
        Expired
    }

    struct AssetConfig {
        address pool;
        uint128 minHarmonicLiquidity;
        bool supported;
    }

    struct Bet {
        address player;
        address asset;
        uint256 wagerAmount;
        uint256 mattEquivalent;
        uint256 payoutAmount;
        uint256 burnAmount;
        uint64 entropyBlock;
        uint64 revealDeadlineBlock;
        int24 meanTick;
        Choice choice;
        BetState state;
        bytes32 commitment;
    }

    error ZeroAddress();
    error UnsupportedAsset(address asset);
    error AssetAlreadySupported(address asset);
    error InvalidPool(address pool);
    error InvalidPoolFactory(address expected, address actual);
    error InvalidPoolPair(address token0, address token1);
    error PoolHasNoLiquidity(address pool);
    error OracleLiquidityTooLow(uint128 actual, uint128 minimum);
    error InvalidMinimumLiquidity();
    error InvalidWagerAmount();
    error WagerTooLarge(uint256 amount);
    error QuoteIsZero();
    error ActiveBetExists(uint256 betId);
    error InsufficientRewardVault(uint256 available, uint256 required);
    error RewardVaultPaused();
    error UnsupportedTokenBehavior();
    error TreasuryTransferFailed();
    error BetNotPending(uint256 betId);
    error NotBetPlayer(address caller, address player);
    error EntropyBlockNotReady(uint256 currentBlock, uint256 requiredBlock);
    error RevealWindowClosed(uint256 currentBlock, uint256 deadlineBlock);
    error RevealWindowStillOpen(uint256 currentBlock, uint256 deadlineBlock);
    error InvalidSecret();
    error EntropyUnavailable();
    error InvalidBasisPoints(uint256 value);
    error InvalidPayoutMultiplier(uint256 value);
    error OutstandingPayoutReservations(uint256 amount);

    address public constant NATIVE_RON = address(0);
    uint256 public constant BPS = 10_000;
    uint32 public constant TWAP_WINDOW = 30 minutes;
    uint16 public constant TARGET_OBSERVATION_CARDINALITY = 32;
    uint64 public constant ENTROPY_DELAY_BLOCKS = 1;
    uint64 public constant REVEAL_WINDOW_BLOCKS = 200;

    IERC20 public immutable matt;
    address public immutable wrappedRon;
    address public immutable katanaV3Factory;
    address payable public immutable treasury;

    IMattRewardVault public rewardVault;
    uint16 public burnBps = 7_500;
    uint32 public payoutMultiplierBps = 20_000;
    uint256 public nextBetId = 1;
    uint256 public reservedPayouts;
    uint256 public totalGames;
    uint256 public totalMattPaid;
    uint256 public totalMattBurned;

    mapping(address asset => AssetConfig config) public assetConfigs;
    mapping(uint256 betId => Bet bet) public bets;
    mapping(address player => uint256 betId) public activeBetOf;

    event SupportedAssetAdded(
        address indexed asset,
        address indexed pool,
        uint128 minHarmonicLiquidity
    );
    event SupportedAssetRemoved(address indexed asset);
    event V3PoolUpdated(
        address indexed asset,
        address indexed previousPool,
        address indexed newPool,
        uint128 minHarmonicLiquidity
    );
    event RewardVaultConfigured(address indexed previousVault, address indexed newVault);
    event BurnBpsConfigured(uint16 previousBps, uint16 newBps);
    event PayoutMultiplierConfigured(uint32 previousBps, uint32 newBps);
    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        address indexed asset,
        Choice choice,
        uint256 wagerAmount,
        uint256 mattEquivalent,
        uint256 payoutAmount,
        uint256 burnAmount,
        uint256 entropyBlock,
        uint256 revealDeadlineBlock,
        bytes32 commitment
    );
    event GamePlayed(
        uint256 indexed betId,
        address indexed player,
        address indexed asset,
        uint256 wagerAmount,
        uint256 mattEquivalent,
        Choice choice,
        Choice outcome,
        bool won,
        bool expired,
        uint256 payoutAmount,
        uint256 burnAmount
    );
    event WinnerPaid(uint256 indexed betId, address indexed player, uint256 amount);
    event MattBurned(uint256 indexed betId, address indexed player, uint256 amount, bool expired);
    event TreasuryDeposit(
        uint256 indexed betId,
        address indexed player,
        address indexed asset,
        uint256 amount
    );
    event PoolPriceUsed(
        uint256 indexed betId,
        address indexed asset,
        address indexed pool,
        uint32 twapWindow,
        int24 arithmeticMeanTick,
        uint128 harmonicMeanLiquidity,
        uint256 mattEquivalent
    );
    event BetExpired(uint256 indexed betId, address indexed player);
    event AccidentalTokenWithdrawn(address indexed token, uint256 amount);
    event AccidentalRonWithdrawn(uint256 amount);

    constructor(
        address mattToken,
        address wrappedRonToken,
        address v3Factory,
        address payable treasurySafe,
        address initialRewardVault,
        address initialOwner
    ) Ownable(initialOwner) {
        if (
            mattToken == address(0) || wrappedRonToken == address(0)
                || v3Factory == address(0) || treasurySafe == address(0)
                || initialRewardVault == address(0) || initialOwner == address(0)
        ) revert ZeroAddress();
        matt = IERC20(mattToken);
        wrappedRon = wrappedRonToken;
        katanaV3Factory = v3Factory;
        treasury = treasurySafe;
        rewardVault = IMattRewardVault(initialRewardVault);
        _pause();
    }

    function commitmentFor(
        address player,
        address asset,
        Choice choice,
        uint256 amount,
        bytes32 secret
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                secret,
                player,
                asset,
                choice,
                amount,
                address(this),
                block.chainid
            )
        );
    }

    function quoteMatt(address asset, uint256 amount)
        public
        view
        returns (
            uint256 mattEquivalent,
            int24 arithmeticMeanTick,
            uint128 harmonicMeanLiquidity,
            address pool
        )
    {
        AssetConfig memory config = assetConfigs[asset];
        if (!config.supported) revert UnsupportedAsset(asset);
        if (amount == 0) revert InvalidWagerAmount();
        if (amount > type(uint128).max) revert WagerTooLarge(amount);

        pool = config.pool;
        (arithmeticMeanTick, harmonicMeanLiquidity) =
            KatanaTwap.consult(pool, TWAP_WINDOW);
        if (harmonicMeanLiquidity < config.minHarmonicLiquidity) {
            revert OracleLiquidityTooLow(
                harmonicMeanLiquidity,
                config.minHarmonicLiquidity
            );
        }
        address oracleToken = asset == NATIVE_RON ? wrappedRon : asset;
        mattEquivalent = KatanaTwap.getQuoteAtTick(
            arithmeticMeanTick,
            uint128(amount),
            oracleToken,
            address(matt)
        );
        if (mattEquivalent == 0) revert QuoteIsZero();
    }

    function placeBet(
        address asset,
        Choice choice,
        uint256 amount,
        bytes32 commitment
    ) external nonReentrant whenNotPaused returns (uint256 betId) {
        if (asset == NATIVE_RON) revert InvalidWagerAmount();
        betId = _placeBet(msg.sender, asset, choice, amount, commitment);
        uint256 beforeBalance = IERC20(asset).balanceOf(treasury);
        IERC20(asset).safeTransferFrom(msg.sender, treasury, amount);
        if (IERC20(asset).balanceOf(treasury) - beforeBalance != amount) {
            revert UnsupportedTokenBehavior();
        }
        emit TreasuryDeposit(betId, msg.sender, asset, amount);
    }

    function placeRonBet(Choice choice, bytes32 commitment)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        betId = _placeBet(
            msg.sender,
            NATIVE_RON,
            choice,
            msg.value,
            commitment
        );
        (bool sent,) = treasury.call{value: msg.value}("");
        if (!sent) revert TreasuryTransferFailed();
        emit TreasuryDeposit(betId, msg.sender, NATIVE_RON, msg.value);
    }

    function revealAndSettle(uint256 betId, bytes32 secret)
        external
        nonReentrant
        returns (bool won)
    {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (msg.sender != bet.player) {
            revert NotBetPlayer(msg.sender, bet.player);
        }
        if (block.number <= bet.entropyBlock) {
            revert EntropyBlockNotReady(
                block.number,
                uint256(bet.entropyBlock) + 1
            );
        }
        if (block.number > bet.revealDeadlineBlock) {
            revert RevealWindowClosed(block.number, bet.revealDeadlineBlock);
        }
        if (
            commitmentFor(
                msg.sender,
                bet.asset,
                bet.choice,
                bet.wagerAmount,
                secret
            ) != bet.commitment
        ) revert InvalidSecret();

        bytes32 entropyHash = blockhash(bet.entropyBlock);
        if (entropyHash == bytes32(0)) revert EntropyUnavailable();
        uint256 randomWord = uint256(
            keccak256(
                abi.encodePacked(
                    secret,
                    entropyHash,
                    betId,
                    address(this),
                    block.chainid
                )
            )
        );
        Choice outcome = Choice(uint8(randomWord & 1));
        won = outcome == bet.choice;
        _clearReservation(bet);
        bet.state = won ? BetState.Won : BetState.Lost;

        if (won) {
            rewardVault.payWinner(bet.player, bet.payoutAmount);
            totalMattPaid += bet.payoutAmount;
            emit WinnerPaid(betId, bet.player, bet.payoutAmount);
        } else {
            rewardVault.burnMatt(bet.burnAmount);
            totalMattBurned += bet.burnAmount;
            emit MattBurned(betId, bet.player, bet.burnAmount, false);
        }

        totalGames++;
        emit GamePlayed(
            betId,
            bet.player,
            bet.asset,
            bet.wagerAmount,
            bet.mattEquivalent,
            bet.choice,
            outcome,
            won,
            false,
            bet.payoutAmount,
            bet.burnAmount
        );
    }

    function expireBet(uint256 betId) external nonReentrant {
        Bet storage bet = bets[betId];
        if (bet.state != BetState.Pending) revert BetNotPending(betId);
        if (block.number <= bet.revealDeadlineBlock) {
            revert RevealWindowStillOpen(
                block.number,
                uint256(bet.revealDeadlineBlock) + 1
            );
        }
        _clearReservation(bet);
        bet.state = BetState.Expired;
        rewardVault.burnMatt(bet.burnAmount);
        totalMattBurned += bet.burnAmount;
        totalGames++;

        emit MattBurned(betId, bet.player, bet.burnAmount, true);
        emit GamePlayed(
            betId,
            bet.player,
            bet.asset,
            bet.wagerAmount,
            bet.mattEquivalent,
            bet.choice,
            Choice(uint8(1) - uint8(bet.choice)),
            false,
            true,
            bet.payoutAmount,
            bet.burnAmount
        );
        emit BetExpired(betId, bet.player);
    }

    function addSupportedAsset(
        address asset,
        address pool,
        uint128 minHarmonicLiquidity
    ) external onlyOwner whenPaused {
        if (assetConfigs[asset].supported) {
            revert AssetAlreadySupported(asset);
        }
        _setAsset(asset, pool, minHarmonicLiquidity);
        emit SupportedAssetAdded(asset, pool, minHarmonicLiquidity);
    }

    function removeSupportedAsset(address asset) external onlyOwner whenPaused {
        if (!assetConfigs[asset].supported) revert UnsupportedAsset(asset);
        delete assetConfigs[asset];
        emit SupportedAssetRemoved(asset);
    }

    function updateV3Pool(
        address asset,
        address newPool,
        uint128 minHarmonicLiquidity
    ) external onlyOwner whenPaused {
        AssetConfig memory current = assetConfigs[asset];
        if (!current.supported) revert UnsupportedAsset(asset);
        _setAsset(asset, newPool, minHarmonicLiquidity);
        emit V3PoolUpdated(
            asset,
            current.pool,
            newPool,
            minHarmonicLiquidity
        );
    }

    function configureRewardVault(address newVault)
        external
        onlyOwner
        whenPaused
    {
        if (newVault == address(0)) revert ZeroAddress();
        if (reservedPayouts != 0) {
            revert OutstandingPayoutReservations(reservedPayouts);
        }
        address previous = address(rewardVault);
        rewardVault = IMattRewardVault(newVault);
        emit RewardVaultConfigured(previous, newVault);
    }

    function configureBurnBps(uint16 newBurnBps) external onlyOwner whenPaused {
        if (newBurnBps > BPS) revert InvalidBasisPoints(newBurnBps);
        uint16 previous = burnBps;
        burnBps = newBurnBps;
        emit BurnBpsConfigured(previous, newBurnBps);
    }

    function configurePayoutMultiplier(uint32 newMultiplierBps)
        external
        onlyOwner
        whenPaused
    {
        if (newMultiplierBps < BPS || newMultiplierBps > 100_000) {
            revert InvalidPayoutMultiplier(newMultiplierBps);
        }
        uint32 previous = payoutMultiplierBps;
        payoutMultiplierBps = newMultiplierBps;
        emit PayoutMultiplierConfigured(previous, newMultiplierBps);
    }

    function availableRewardBalance() public view returns (uint256) {
        uint256 balance = matt.balanceOf(address(rewardVault));
        return balance > reservedPayouts ? balance - reservedPayouts : 0;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (rewardVault.paused()) revert RewardVaultPaused();
        _unpause();
    }

    function emergencyWithdrawAccidentalToken(address token, uint256 amount)
        external
        onlyOwner
        whenPaused
        nonReentrant
    {
        if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(treasury, amount);
        emit AccidentalTokenWithdrawn(token, amount);
    }

    function emergencyWithdrawAccidentalRon(uint256 amount)
        external
        onlyOwner
        whenPaused
        nonReentrant
    {
        (bool sent,) = treasury.call{value: amount}("");
        if (!sent) revert TreasuryTransferFailed();
        emit AccidentalRonWithdrawn(amount);
    }

    function _placeBet(
        address player,
        address asset,
        Choice choice,
        uint256 amount,
        bytes32 commitment
    ) private returns (uint256 betId) {
        if (amount == 0) revert InvalidWagerAmount();
        uint256 current = activeBetOf[player];
        if (current != 0) revert ActiveBetExists(current);

        (
            uint256 mattEquivalent,
            int24 meanTick,
            uint128 harmonicLiquidity,
            address pool
        ) = quoteMatt(asset, amount);
        uint256 payoutAmount =
            mattEquivalent * payoutMultiplierBps / BPS;
        uint256 burnAmount = mattEquivalent * burnBps / BPS;
        uint256 required = reservedPayouts + payoutAmount;
        uint256 vaultBalance = matt.balanceOf(address(rewardVault));
        if (vaultBalance < required) {
            revert InsufficientRewardVault(vaultBalance, required);
        }
        if (rewardVault.paused()) revert RewardVaultPaused();

        betId = nextBetId++;
        uint64 entropyBlock = uint64(block.number + ENTROPY_DELAY_BLOCKS);
        uint64 deadline = entropyBlock + REVEAL_WINDOW_BLOCKS;
        bets[betId] = Bet({
            player: player,
            asset: asset,
            wagerAmount: amount,
            mattEquivalent: mattEquivalent,
            payoutAmount: payoutAmount,
            burnAmount: burnAmount,
            entropyBlock: entropyBlock,
            revealDeadlineBlock: deadline,
            meanTick: meanTick,
            choice: choice,
            state: BetState.Pending,
            commitment: commitment
        });
        activeBetOf[player] = betId;
        reservedPayouts = required;

        emit PoolPriceUsed(
            betId,
            asset,
            pool,
            TWAP_WINDOW,
            meanTick,
            harmonicLiquidity,
            mattEquivalent
        );
        emit BetPlaced(
            betId,
            player,
            asset,
            choice,
            amount,
            mattEquivalent,
            payoutAmount,
            burnAmount,
            entropyBlock,
            deadline,
            commitment
        );
    }

    function _clearReservation(Bet storage bet) private {
        activeBetOf[bet.player] = 0;
        reservedPayouts -= bet.payoutAmount;
    }

    function _setAsset(
        address asset,
        address pool,
        uint128 minHarmonicLiquidity
    ) private {
        if (pool == address(0) || pool.code.length == 0) {
            revert InvalidPool(pool);
        }
        if (minHarmonicLiquidity == 0) {
            revert InvalidMinimumLiquidity();
        }
        address oracleToken = asset == NATIVE_RON ? wrappedRon : asset;
        if (oracleToken == address(matt)) revert InvalidPool(pool);

        IKatanaV3Pool katanaPool = IKatanaV3Pool(pool);
        address actualFactory = katanaPool.factory();
        if (actualFactory != katanaV3Factory) {
            revert InvalidPoolFactory(katanaV3Factory, actualFactory);
        }
        address token0 = katanaPool.token0();
        address token1 = katanaPool.token1();
        bool validPair = (token0 == oracleToken && token1 == address(matt))
            || (token0 == address(matt) && token1 == oracleToken);
        if (!validPair) revert InvalidPoolPair(token0, token1);
        if (katanaPool.liquidity() == 0) revert PoolHasNoLiquidity(pool);

        katanaPool.increaseObservationCardinalityNext(
            TARGET_OBSERVATION_CARDINALITY
        );
        assetConfigs[asset] = AssetConfig({
            pool: pool,
            minHarmonicLiquidity: minHarmonicLiquidity,
            supported: true
        });
    }
}
