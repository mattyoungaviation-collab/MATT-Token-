// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IProjectDynoSwapAdapter} from "./interfaces/IProjectDynoSwapAdapter.sol";
import {IProjectDynoPriceGuard} from "./interfaces/IProjectDynoPriceGuard.sol";

interface IDynoEmergencyAuthority {
    function emergencyAdmin() external view returns (address);
}

/// @notice Exact seven-day, 168-slot Project DYNO buyback schedule.
/// @dev Immediate upgrades belong to DEFAULT_ADMIN_ROLE, including manager-derived emergency admin.
contract ProjectDynoBuybackVault is Initializable, UUPSUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint16 public constant SLOT_COUNT = 168;
    uint32 public constant SLOT_SECONDS = 1 hours;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;
    // Caller-controlled low gas must not turn an otherwise valid swap into a terminal FAILED slot.
    uint256 public constant SWAP_CALL_GAS = 5_000_000;
    uint256 public constant SWAP_CALL_RESERVE_GAS = 300_000;

    enum ScheduleState { NONE, ACTIVE, CLOSED }
    enum SlotStatus { PENDING, SUCCESS, FAILED, MISSED }

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidState();
    error InvalidSlot();
    error PublicAttemptFailed();
    error InsufficientExecutionGas();
    error TransferFailed();

    address public raffleManager;
    ScheduleState public scheduleState;
    uint256 public roundId;
    address public treasury;
    IERC20 public matt;
    IProjectDynoSwapAdapter public adapter;
    IProjectDynoPriceGuard public guard;
    uint16 public slippageBps;
    bool public executionPaused;

    uint256 public originalBudget;
    uint256 public slice;
    uint256 public dust;
    uint64 public t0;
    uint64 public endTime;
    uint256 public successfulSpend;
    uint256 public mattDelivered;
    uint16 public successCount;
    uint16 public failedCount;
    uint16 public missedCount;
    uint256 public returnedAmount;
    uint256 public returnLiability;

    mapping(uint16 slot => SlotStatus) private _slotStatus;
    mapping(uint16 slot => uint256 mattOut) public slotMattOut;
    mapping(uint16 slot => bytes32 reasonHash) public slotFailureReason;

    event BuybackStarted(uint256 indexed roundId, uint256 budget, uint256 slice, uint256 dust, uint64 t0, uint64 endTime, address indexed treasury);
    event BuybackSlotSucceeded(uint256 indexed roundId, uint16 indexed slot, uint256 ronSpent, uint256 mattDelivered);
    event BuybackSlotFailed(uint256 indexed roundId, uint16 indexed slot, bytes32 reasonHash, address indexed actor);
    event BuybackSlotMissed(uint256 indexed roundId, uint16 indexed slot);
    event BuybackClosed(uint256 indexed roundId, uint256 originalBudget, uint256 spent, uint256 returned, uint256 mattDelivered, uint16 successCount, uint16 failedCount, uint16 missedCount);
    event ReturnCredited(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event ReturnClaimed(uint256 indexed roundId, address indexed treasury, uint256 amount);
    event ProtectionUpdated(uint16 oldSlippageBps, uint16 newSlippageBps, address indexed actor);
    event ExecutionPauseUpdated(bool paused, address indexed actor);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address manager, address keeper) external initializer {
        if (admin == address(0) || manager == address(0)) revert InvalidConfiguration();
        __AccessControl_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (keeper != address(0)) _grantRole(KEEPER_ROLE, keeper);
        raffleManager = manager;
    }

    function startBuyback(
        uint256 roundId_,
        address treasury_,
        address matt_,
        address adapter_,
        address guard_,
        uint16 slippageBps_
    ) external payable nonReentrant {
        if (msg.sender != raffleManager) revert Unauthorized();
        if (scheduleState != ScheduleState.NONE || treasury_ == address(0) || matt_ == address(0) || adapter_ == address(0) || guard_ == address(0)) revert InvalidConfiguration();
        if (slippageBps_ > MAX_SLIPPAGE_BPS || msg.value < SLOT_COUNT) revert InvalidConfiguration();
        if (IProjectDynoSwapAdapter(adapter_).matt() != matt_) revert InvalidConfiguration();

        roundId = roundId_;
        treasury = treasury_;
        matt = IERC20(matt_);
        adapter = IProjectDynoSwapAdapter(adapter_);
        guard = IProjectDynoPriceGuard(guard_);
        slippageBps = slippageBps_;
        originalBudget = msg.value;
        slice = msg.value / SLOT_COUNT;
        dust = msg.value - (slice * SLOT_COUNT);
        t0 = uint64(block.timestamp);
        endTime = uint64(block.timestamp + uint256(SLOT_COUNT) * SLOT_SECONDS);
        scheduleState = ScheduleState.ACTIVE;
        emit BuybackStarted(roundId_, msg.value, slice, dust, t0, endTime, treasury_);
    }

    function currentSlot() public view returns (uint16) {
        if (scheduleState != ScheduleState.ACTIVE || block.timestamp < t0 || block.timestamp >= endTime) revert InvalidSlot();
        return uint16((block.timestamp - t0) / SLOT_SECONDS);
    }

    /// @notice Anyone may complete a valid swap. Only a keeper/admin may consume a slot after an authenticated failure.
    function executeCurrentSlot() external nonReentrant returns (uint256 delivered) {
        if (scheduleState != ScheduleState.ACTIVE || executionPaused) revert InvalidState();
        uint16 slot = currentSlot();
        if (_slotStatus[slot] != SlotStatus.PENDING) revert InvalidSlot();
        if (gasleft() < SWAP_CALL_GAS + SWAP_CALL_RESERVE_GAS) revert InsufficientExecutionGas();

        try this.executeSwap{gas: SWAP_CALL_GAS}(slot) returns (uint256 amount) {
            _slotStatus[slot] = SlotStatus.SUCCESS;
            slotMattOut[slot] = amount;
            successfulSpend += slice;
            mattDelivered += amount;
            successCount += 1;
            emit BuybackSlotSucceeded(roundId, slot, slice, amount);
            return amount;
        } catch (bytes memory reason) {
            if (!hasRole(KEEPER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert PublicAttemptFailed();
            _slotStatus[slot] = SlotStatus.FAILED;
            failedCount += 1;
            bytes32 reasonHash = keccak256(reason);
            slotFailureReason[slot] = reasonHash;
            emit BuybackSlotFailed(roundId, slot, reasonHash, msg.sender);
            return 0;
        }
    }

    /// @dev External self-call gives the parent a catch boundary; all swap effects revert before a terminal failure is recorded.
    function executeSwap(uint16 slot) external returns (uint256 delivered) {
        if (msg.sender != address(this)) revert Unauthorized();
        if (slot != currentSlot() || _slotStatus[slot] != SlotStatus.PENDING) revert InvalidSlot();
        guard.validate();
        uint256 minOut = guard.buybackMinOut(slice, slippageBps);
        if (minOut == 0) revert InvalidConfiguration();
        uint256 beforeBalance = matt.balanceOf(address(this));
        uint256 reported = adapter.buyMatt{value: slice}(address(this), minOut);
        uint256 received = matt.balanceOf(address(this)) - beforeBalance;
        if (received < minOut || reported != received) revert InvalidConfiguration();
        uint256 treasuryBefore = matt.balanceOf(treasury);
        matt.safeTransfer(treasury, received);
        delivered = matt.balanceOf(treasury) - treasuryBefore;
        if (delivered != received) revert InvalidConfiguration();
    }

    function markExpiredSlots(uint16 maxSlots) external returns (uint16 marked) {
        if (scheduleState != ScheduleState.ACTIVE || maxSlots == 0) return 0;
        uint256 elapsed = block.timestamp <= t0 ? 0 : (block.timestamp - t0) / SLOT_SECONDS;
        uint16 exclusive = elapsed > SLOT_COUNT ? SLOT_COUNT : uint16(elapsed);
        for (uint16 i = 0; i < exclusive && marked < maxSlots; ++i) {
            if (_slotStatus[i] == SlotStatus.PENDING) {
                _slotStatus[i] = SlotStatus.MISSED;
                missedCount += 1;
                marked += 1;
                emit BuybackSlotMissed(roundId, i);
            }
        }
    }

    function closeBuyback() external nonReentrant {
        if (scheduleState != ScheduleState.ACTIVE || block.timestamp < endTime) revert InvalidState();
        for (uint16 i = 0; i < SLOT_COUNT; ++i) {
            if (_slotStatus[i] == SlotStatus.PENDING) {
                _slotStatus[i] = SlotStatus.MISSED;
                missedCount += 1;
                emit BuybackSlotMissed(roundId, i);
            }
        }
        scheduleState = ScheduleState.CLOSED;
        uint256 amount = originalBudget - successfulSpend;
        (bool ok,) = payable(treasury).call{value: amount}("");
        if (ok) returnedAmount = amount;
        else {
            returnLiability = amount;
            emit ReturnCredited(roundId, treasury, amount);
        }
        emit BuybackClosed(roundId, originalBudget, successfulSpend, amount, mattDelivered, successCount, failedCount, missedCount);
    }

    function claimReturn() external nonReentrant {
        if (msg.sender != treasury || returnLiability == 0) revert Unauthorized();
        uint256 amount = returnLiability;
        returnLiability = 0;
        (bool ok,) = payable(treasury).call{value: amount}("");
        if (!ok) {
            returnLiability = amount;
            revert TransferFailed();
        }
        returnedAmount = amount;
        emit ReturnClaimed(roundId, treasury, amount);
    }

    function setSlippageBps(uint16 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newValue > MAX_SLIPPAGE_BPS) revert InvalidConfiguration();
        uint16 oldValue = slippageBps;
        slippageBps = newValue;
        emit ProtectionUpdated(oldValue, newValue, msg.sender);
    }

    function setExecutionPaused(bool paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        executionPaused = paused;
        emit ExecutionPauseUpdated(paused, msg.sender);
    }

    function getSlotStatus(uint16 slot) external view returns (SlotStatus) {
        if (slot >= SLOT_COUNT) revert InvalidSlot();
        return _slotStatus[slot];
    }

    function terminalSlotCount() external view returns (uint16) {
        return successCount + failedCount + missedCount;
    }

    function isClosed() external view returns (bool) {
        return scheduleState == ScheduleState.CLOSED;
    }

    function getSchedule() external view returns (
        ScheduleState state,
        uint256 budget,
        uint256 hourlySlice,
        uint256 roundingDust,
        uint64 startsAt,
        uint64 endsAt,
        uint256 spent,
        uint256 delivered,
        uint256 unreturned
    ) {
        return (scheduleState, originalBudget, slice, dust, t0, endTime, successfulSpend, mattDelivered, returnLiability);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @notice Rotation/revocation follows the manager immediately, without duplicate role grants.
    function hasRole(bytes32 role, address account) public view override returns (bool) {
        if (super.hasRole(role, account)) return true;
        if (role != DEFAULT_ADMIN_ROLE || account == address(0) || raffleManager.code.length == 0) return false;
        try IDynoEmergencyAuthority(raffleManager).emergencyAdmin() returns (address emergency) { return account == emergency; }
        catch { return false; }
    }

    function revokeRole(bytes32 role, address account) public override {
        if (role == DEFAULT_ADMIN_ROLE && !super.hasRole(role, account) && hasRole(role, account)) revert InvalidConfiguration();
        super.revokeRole(role, account);
    }

    function renounceRole(bytes32 role, address confirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE && !super.hasRole(role, confirmation) && hasRole(role, confirmation)) revert InvalidConfiguration();
        super.renounceRole(role, confirmation);
    }

    uint256[32] private __gap;
}
