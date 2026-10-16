// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IKatanaV3GuardPool, IKatanaV3GuardFactory} from "./interfaces/IKatanaV3GuardPool.sol";
import {KatanaTwap} from "../libraries/KatanaTwap.sol";

interface IDynoGuardAuthority {
    function multisig() external view returns (address);
    function emergencyAdmin() external view returns (address);
}

/// @notice Katana V3 output guard with an optional historical reference.
/// @dev A zero reference window explicitly selects spot-only mode. It avoids
///      oracle-history liveness failures but is vulnerable to spot manipulation.
/// @dev This is only compatible with a pool whose on-chain interface has been verified as Katana V3.
contract ProjectDynoKatanaV3PriceGuard {
    uint16 public constant MAX_BPS = 10_000;
    address public immutable matt;
    address public immutable wron;
    IKatanaV3GuardPool public immutable pool;
    uint24 public immutable poolFee;
    uint256 public constant FEE_DENOMINATOR = 1_000_000;
    address public immutable expectedFactory;
    address public admin;
    uint32 public referenceWindow;
    uint16 public maximumDeviationBps;
    uint128 public minimumHarmonicLiquidity;
    address public governanceManager;

    error Unauthorized();
    error InvalidConfiguration();
    error InsufficientLiquidity();
    error ExcessiveDeviation();

    event ProtectionUpdated(uint32 oldWindow, uint32 window, uint16 oldDeviationBps, uint16 deviationBps, uint128 oldMinimumLiquidity, uint128 minimumLiquidity, address indexed actor);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event GovernanceManagerBound(address indexed manager, address indexed actor);

    function isAdmin(address account) public view returns (bool) {
        if (account == address(0)) return false;
        if (account == admin) return true;
        if (governanceManager == address(0)) return false;
        try IDynoGuardAuthority(governanceManager).emergencyAdmin() returns (address emergency) { return account == emergency; }
        catch { return false; }
    }

    function bindGovernanceManager(address manager) external {
        if (msg.sender != admin) revert Unauthorized();
        if (governanceManager != address(0) || manager.code.length == 0 || IDynoGuardAuthority(manager).multisig() != admin) revert InvalidConfiguration();
        governanceManager = manager;
        emit GovernanceManagerBound(manager, msg.sender);
    }

    constructor(address admin_, address matt_, address wron_, address pool_, address factory_, uint128 minimumLiquidity_) {
        if (admin_ == address(0) || matt_ == address(0) || wron_ == address(0) || matt_ == wron_ || pool_.code.length == 0 || factory_.code.length == 0 || minimumLiquidity_ == 0) revert InvalidConfiguration();
        admin = admin_; matt = matt_; wron = wron_; pool = IKatanaV3GuardPool(pool_); expectedFactory = factory_;
        referenceWindow = 1 hours; maximumDeviationBps = 1_000; minimumHarmonicLiquidity = minimumLiquidity_;
        if (pool.factory() != factory_ || !((pool.token0() == matt_ && pool.token1() == wron_) || (pool.token0() == wron_ && pool.token1() == matt_))) revert InvalidConfiguration();
        uint24 fee = pool.fee();
        if (fee >= FEE_DENOMINATOR || IKatanaV3GuardFactory(factory_).getPool(matt_, wron_, fee) != pool_) revert InvalidConfiguration();
        poolFee = fee;
    }

    function setProtection(uint32 window, uint16 deviationBps, uint128 minimumLiquidity) external {
        if (!isAdmin(msg.sender)) revert Unauthorized();
        if (deviationBps > MAX_BPS || minimumLiquidity == 0) revert InvalidConfiguration();
        emit ProtectionUpdated(referenceWindow, window, maximumDeviationBps, deviationBps, minimumHarmonicLiquidity, minimumLiquidity, msg.sender);
        referenceWindow = window; maximumDeviationBps = deviationBps; minimumHarmonicLiquidity = minimumLiquidity;
    }

    function transferAdmin(address newAdmin) external {
        if (!isAdmin(msg.sender)) revert Unauthorized();
        if (newAdmin == address(0)) revert InvalidConfiguration();
        emit AdminChanged(admin, newAdmin); admin = newAdmin;
    }

    function validate() external view { _reference(); }

    function saleMinOut(uint256 mattIn, uint16 slippageBps) external view returns (uint256) {
        if (mattIn == 0 || mattIn > type(uint128).max || slippageBps > 1_000) revert InvalidConfiguration();
        (int24 meanTick,) = _reference();
        uint256 referenceOut = KatanaTwap.getQuoteAtTick(meanTick, _netInput(mattIn), matt, wron);
        uint256 minOut = Math.mulDiv(referenceOut, MAX_BPS - slippageBps, MAX_BPS);
        if (minOut == 0) revert InvalidConfiguration();
        return minOut;
    }

    function buybackMinOut(uint256 ronIn, uint16 slippageBps) external view returns (uint256) {
        if (ronIn == 0 || ronIn > type(uint128).max || slippageBps > 1_000) revert InvalidConfiguration();
        (int24 meanTick,) = _reference();
        uint256 referenceOut = KatanaTwap.getQuoteAtTick(meanTick, _netInput(ronIn), wron, matt);
        uint256 minOut = Math.mulDiv(referenceOut, MAX_BPS - slippageBps, MAX_BPS);
        if (minOut == 0) revert InvalidConfiguration();
        return minOut;
    }

    /// @dev Fees are millionths of input. Floor before quote, then floor the
    /// quote/slippage result. This is a reference floor, not an impact model:
    /// large legitimate swaps can still fail it and require measured simulation.
    function _netInput(uint256 amount) internal view returns (uint128) {
        uint256 net = Math.mulDiv(amount, FEE_DENOMINATOR - poolFee, FEE_DENOMINATOR);
        if (net == 0) revert InvalidConfiguration();
        return uint128(net);
    }

    function _reference() internal view returns (int24 meanTick, uint128 harmonicLiquidity) {
        (, int24 spotTick,,,,,, bool unlocked) = pool.slot0();
        if (!unlocked) revert InvalidConfiguration();
        uint128 activeLiquidity = pool.liquidity();
        if (activeLiquidity < minimumHarmonicLiquidity) revert InsufficientLiquidity();
        if (referenceWindow == 0) return (spotTick, activeLiquidity);
        (meanTick, harmonicLiquidity) = KatanaTwap.consult(address(pool), referenceWindow);
        if (harmonicLiquidity < minimumHarmonicLiquidity) revert InsufficientLiquidity();
        uint256 twapQuote = KatanaTwap.getQuoteAtTick(meanTick, 1 ether, matt, wron);
        uint256 spotQuote = KatanaTwap.getQuoteAtTick(spotTick, 1 ether, matt, wron);
        uint256 difference = twapQuote > spotQuote ? twapQuote - spotQuote : spotQuote - twapQuote;
        if (twapQuote == 0 || Math.mulDiv(difference, MAX_BPS, twapQuote, Math.Rounding.Ceil) > maximumDeviationBps) revert ExcessiveDeviation();
    }
}
