// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IKatanaV3Pool} from "./interfaces/IKatanaV3Pool.sol";
import {KatanaTwap} from "./libraries/KatanaTwap.sol";

interface IWrappedRonForSlots is IERC20 {
    function withdraw(uint256 amount) external;
}

/// @title MATT Slots Treasury Converter
/// @notice Holds settled net-losing MATT, swaps it into WRON through an approved router,
///         unwraps it, and forwards every resulting RON to the immutable treasury.
/// @dev The caller supplies router calldata, but settlement is protected by an exact MATT
///      allowance, balance-delta checks, a 30-minute Katana TWAP floor, and a fixed recipient.
contract MattSlotsTreasuryConverter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint32 public constant TWAP_WINDOW = 30 minutes;
    uint16 public constant MAX_CONFIGURABLE_SLIPPAGE_BPS = 1_500;

    IERC20 public immutable matt;
    IWrappedRonForSlots public immutable wrappedRon;
    address public immutable katanaV3Factory;
    address public immutable pool;
    address payable public immutable treasury;

    address public sourceVault;
    address public router;
    address public keeper;
    uint16 public maxSlippageBps;
    uint128 public minHarmonicLiquidity;

    uint256 public pendingMatt;
    uint256 public totalMattReceived;
    uint256 public totalMattConverted;
    uint256 public totalRonForwarded;

    event SourceVaultConfigured(address indexed sourceVault);
    event RouterConfigured(address indexed previousRouter, address indexed newRouter);
    event KeeperConfigured(address indexed previousKeeper, address indexed newKeeper);
    event ConversionProtectionConfigured(
        uint16 previousMaxSlippageBps,
        uint16 newMaxSlippageBps,
        uint128 previousMinHarmonicLiquidity,
        uint128 newMinHarmonicLiquidity
    );
    event LossRecorded(uint256 amount, uint256 pendingMatt);
    event MattConverted(
        address indexed caller,
        address indexed router,
        uint256 mattIn,
        uint256 ronOut,
        uint256 twapQuote,
        uint256 minimumOut
    );
    event AccidentalRonForwarded(uint256 amount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidPool();
    error InvalidPoolFactory(address expected, address actual);
    error InvalidPoolPair(address token0, address token1);
    error PoolHasNoLiquidity();
    error InvalidBasisPoints(uint256 value);
    error SourceVaultAlreadyConfigured();
    error UnbackedLoss(uint256 available, uint256 required);
    error InsufficientPendingMatt(uint256 available, uint256 requested);
    error OracleLiquidityTooLow(uint128 actual, uint128 minimum);
    error MinimumOutputTooLow(uint256 provided, uint256 required);
    error SwapFailed(bytes reason);
    error UnexpectedMattSpent(uint256 expected, uint256 actual);
    error InsufficientWrappedRon(uint256 minimum, uint256 actual);
    error RonTransferFailed();
    error UnsupportedToken();

    constructor(
        address mattToken,
        address wrappedRonToken,
        address v3Factory,
        address v3Pool,
        address payable treasurySafe,
        address initialRouter,
        address initialKeeper,
        uint16 initialMaxSlippageBps,
        uint128 initialMinHarmonicLiquidity,
        address initialOwner
    ) Ownable(initialOwner) {
        if (
            mattToken == address(0) || wrappedRonToken == address(0)
                || v3Factory == address(0) || v3Pool == address(0)
                || treasurySafe == address(0) || initialRouter == address(0)
                || initialOwner == address(0)
        ) revert InvalidAddress();
        if (initialRouter.code.length == 0) revert InvalidAddress();
        if (initialMaxSlippageBps > MAX_CONFIGURABLE_SLIPPAGE_BPS) {
            revert InvalidBasisPoints(initialMaxSlippageBps);
        }
        if (initialMinHarmonicLiquidity == 0) revert InvalidAmount();

        IKatanaV3Pool configuredPool = IKatanaV3Pool(v3Pool);
        address actualFactory = configuredPool.factory();
        if (actualFactory != v3Factory) revert InvalidPoolFactory(v3Factory, actualFactory);
        address token0 = configuredPool.token0();
        address token1 = configuredPool.token1();
        if (
            !(
                (token0 == mattToken && token1 == wrappedRonToken)
                    || (token0 == wrappedRonToken && token1 == mattToken)
            )
        ) revert InvalidPoolPair(token0, token1);
        if (configuredPool.liquidity() == 0) revert PoolHasNoLiquidity();

        matt = IERC20(mattToken);
        wrappedRon = IWrappedRonForSlots(wrappedRonToken);
        katanaV3Factory = v3Factory;
        pool = v3Pool;
        treasury = treasurySafe;
        router = initialRouter;
        keeper = initialKeeper;
        maxSlippageBps = initialMaxSlippageBps;
        minHarmonicLiquidity = initialMinHarmonicLiquidity;
        _pause();
    }

    modifier onlySourceVault() {
        if (msg.sender != sourceVault) revert Unauthorized();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner()) revert Unauthorized();
        _;
    }

    function configureSourceVault(address vault) external onlyOwner {
        if (sourceVault != address(0)) revert SourceVaultAlreadyConfigured();
        if (vault == address(0) || vault.code.length == 0) revert InvalidAddress();
        sourceVault = vault;
        emit SourceVaultConfigured(vault);
    }

    /// @notice Called after the source vault has transferred the same amount of MATT here.
    function recordLoss(uint256 amount) external onlySourceVault {
        if (amount == 0) revert InvalidAmount();
        uint256 requiredBalance = pendingMatt + amount;
        uint256 balance = matt.balanceOf(address(this));
        if (balance < requiredBalance) revert UnbackedLoss(balance, requiredBalance);
        pendingMatt = requiredBalance;
        totalMattReceived += amount;
        emit LossRecorded(amount, requiredBalance);
    }

    /// @notice Converts queued MATT through the approved router and forwards native RON.
    /// @param routerCall Calldata that must spend exactly amountIn MATT and deliver WRON here.
    function convert(
        uint256 amountIn,
        uint256 amountOutMinimum,
        bytes calldata routerCall
    ) external whenNotPaused nonReentrant onlyKeeperOrOwner returns (uint256 ronOut) {
        if (amountIn == 0 || amountIn > type(uint128).max || routerCall.length < 4) {
            revert InvalidAmount();
        }
        if (amountIn > pendingMatt) revert InsufficientPendingMatt(pendingMatt, amountIn);

        (uint256 twapQuote, uint128 harmonicLiquidity) = quoteTwap(amountIn);
        if (harmonicLiquidity < minHarmonicLiquidity) {
            revert OracleLiquidityTooLow(harmonicLiquidity, minHarmonicLiquidity);
        }
        uint256 requiredMinimum = Math.mulDiv(
            twapQuote,
            BPS - maxSlippageBps,
            BPS
        );
        if (amountOutMinimum < requiredMinimum) {
            revert MinimumOutputTooLow(amountOutMinimum, requiredMinimum);
        }

        uint256 mattBefore = matt.balanceOf(address(this));
        uint256 wronBefore = wrappedRon.balanceOf(address(this));
        matt.forceApprove(router, amountIn);
        (bool success, bytes memory reason) = router.call(routerCall);
        if (!success) revert SwapFailed(reason);
        matt.forceApprove(router, 0);

        uint256 mattAfter = matt.balanceOf(address(this));
        uint256 spent = mattBefore > mattAfter ? mattBefore - mattAfter : 0;
        if (spent != amountIn) revert UnexpectedMattSpent(amountIn, spent);

        uint256 wronAfter = wrappedRon.balanceOf(address(this));
        ronOut = wronAfter > wronBefore ? wronAfter - wronBefore : 0;
        if (ronOut < amountOutMinimum) {
            revert InsufficientWrappedRon(amountOutMinimum, ronOut);
        }

        pendingMatt -= amountIn;
        totalMattConverted += amountIn;
        totalRonForwarded += ronOut;

        wrappedRon.withdraw(ronOut);
        (bool sent,) = treasury.call{value: ronOut}("");
        if (!sent) revert RonTransferFailed();

        emit MattConverted(
            msg.sender,
            router,
            amountIn,
            ronOut,
            twapQuote,
            amountOutMinimum
        );
    }

    function quoteTwap(uint256 amountIn)
        public
        view
        returns (uint256 wrappedRonOut, uint128 harmonicLiquidity)
    {
        if (amountIn == 0 || amountIn > type(uint128).max) revert InvalidAmount();
        (int24 meanTick, uint128 liquidity) = KatanaTwap.consult(pool, TWAP_WINDOW);
        wrappedRonOut = KatanaTwap.getQuoteAtTick(
            meanTick,
            uint128(amountIn),
            address(matt),
            address(wrappedRon)
        );
        if (wrappedRonOut == 0) revert InvalidAmount();
        harmonicLiquidity = liquidity;
    }

    function setRouter(address newRouter) external onlyOwner whenPaused {
        if (newRouter == address(0) || newRouter.code.length == 0) revert InvalidAddress();
        address previous = router;
        router = newRouter;
        emit RouterConfigured(previous, newRouter);
    }

    function setKeeper(address newKeeper) external onlyOwner {
        address previous = keeper;
        keeper = newKeeper;
        emit KeeperConfigured(previous, newKeeper);
    }

    function setConversionProtection(
        uint16 newMaxSlippageBps,
        uint128 newMinHarmonicLiquidity
    ) external onlyOwner whenPaused {
        if (newMaxSlippageBps > MAX_CONFIGURABLE_SLIPPAGE_BPS) {
            revert InvalidBasisPoints(newMaxSlippageBps);
        }
        if (newMinHarmonicLiquidity == 0) revert InvalidAmount();
        uint16 previousSlippage = maxSlippageBps;
        uint128 previousLiquidity = minHarmonicLiquidity;
        maxSlippageBps = newMaxSlippageBps;
        minHarmonicLiquidity = newMinHarmonicLiquidity;
        emit ConversionProtectionConfigured(
            previousSlippage,
            newMaxSlippageBps,
            previousLiquidity,
            newMinHarmonicLiquidity
        );
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        if (sourceVault == address(0)) revert InvalidAddress();
        _unpause();
    }

    function forwardAccidentalRon() external onlyOwner nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert InvalidAmount();
        (bool sent,) = treasury.call{value: amount}("");
        if (!sent) revert RonTransferFailed();
        emit AccidentalRonForwarded(amount);
    }

    function recoverUnsupportedToken(address token, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(matt) || token == address(wrappedRon)) revert UnsupportedToken();
        if (token == address(0) || amount == 0) revert InvalidAmount();
        IERC20(token).safeTransfer(treasury, amount);
    }

    receive() external payable {
        if (msg.sender != address(wrappedRon)) revert Unauthorized();
    }
}
