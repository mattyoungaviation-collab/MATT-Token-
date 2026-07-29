// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRoninVRFCoordinatorForGiftBoxes {
    function requestRandomSeed(
        uint256 callbackGasLimit,
        uint256 gasPrice,
        address consumer,
        address refundAddress
    ) external payable returns (bytes32 requestHash);

    function estimateRequestRandomFee(uint256 callbackGasLimit, uint256 gasPrice)
        external
        view
        returns (uint256);
}

interface IMattGiftBoxVault {
    function reserve(uint256 boxId, address recipient, uint256 maximumPayout) external;
    function settle(uint256 boxId, uint256 payout) external;
    function availableBankroll() external view returns (uint256);
    function claimable(address recipient) external view returns (uint256);
}

/// @title MATT Gift Boxes
/// @notice RON-funded gift boxes with owner-signed MATT quotes and Ronin VRF outcomes.
/// @dev RON sale proceeds are forwarded to the owner immediately. MATT is paid only by
///      the separate vault, which reserves the full 7.5x liability before every sale.
contract MattGiftBoxes is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    uint256 public constant BPS = 10_000;
    uint32 public constant MIN_MULTIPLIER_BPS = 8_500;
    uint32 public constant MAX_MULTIPLIER_BPS = 75_000;
    uint256 public constant MIN_BOX_PRICE = 100 ether;
    uint256 public constant MAX_BOX_PRICE = 500 ether;
    uint256 public constant CONFIG_DELAY = 24 hours;
    uint256 public constant RETRY_DELAY = 30 minutes;
    uint256 public constant STALE_DELAY = 2 hours;
    uint256 public constant CALLBACK_GAS_LIMIT = 240_000;
    uint8 public constant MAX_RETRIES = 2;
    uint8 public constant MAX_OUTCOMES = 20;

    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_SETTLED = 2;

    bytes32 public constant PRICE_QUOTE_TYPEHASH = keccak256(
        "PriceQuote(address buyer,address recipient,uint8 tier,uint256 baseMatt,uint256 nonce,uint64 deadline,uint256 configVersion)"
    );

    struct Configuration {
        uint256[3] prices;
        uint32[] multipliersBps;
        uint16[] chancesBps;
        uint64 activatesAt;
        bool exists;
    }

    struct GiftBox {
        address buyer;
        address recipient;
        uint128 baseMatt;
        uint128 priceRon;
        uint64 purchasedAt;
        uint64 lastRequestAt;
        uint32 configVersion;
        uint32 multiplierBps;
        uint8 tier;
        uint8 status;
        uint8 retries;
        uint256 payout;
    }

    IMattGiftBoxVault public immutable vault;
    IRoninVRFCoordinatorForGiftBoxes public immutable vrfCoordinator;

    uint256 public activeConfigVersion;
    uint256 public pendingConfigVersion;
    uint256 public latestConfigVersion;
    uint256 public nextBoxId = 1;
    uint256 public totalBoxesPurchased;
    uint256 public totalRonForwarded;
    uint256 public totalMattAwarded;

    mapping(uint256 version => Configuration config) private configurations;
    mapping(uint256 boxId => GiftBox box) public boxes;
    mapping(bytes32 requestHash => uint256 boxId) public requestToBox;
    mapping(address buyer => mapping(uint256 nonce => bool used)) public usedNonces;

    event ConfigurationProposed(uint256 indexed version, uint64 activatesAt);
    event ConfigurationActivated(uint256 indexed version);
    event ConfigurationCancelled(uint256 indexed version);
    event RandomnessReserveFunded(address indexed owner, uint256 amount);
    event RandomnessReserveWithdrawn(address indexed owner, uint256 amount);
    event BoxPurchased(
        uint256 indexed boxId,
        bytes32 indexed requestHash,
        address indexed buyer,
        address recipient,
        uint8 tier,
        uint256 priceRon,
        uint256 baseMatt,
        uint256 configVersion
    );
    event RandomnessRetried(uint256 indexed boxId, bytes32 indexed requestHash, uint8 retry);
    event BoxSettled(
        uint256 indexed boxId,
        address indexed recipient,
        uint32 multiplierBps,
        uint256 payout
    );
    event StaleBoxSettled(uint256 indexed boxId, address indexed recipient, uint256 payout);
    event LateFulfillmentIgnored(bytes32 indexed requestHash, uint256 indexed boxId);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidConfiguration();
    error InvalidTier();
    error InvalidQuote();
    error QuoteExpired();
    error NonceAlreadyUsed();
    error InsufficientBankroll();
    error InsufficientRandomnessReserve();
    error InvalidRequest();
    error RequestAlreadySettled();
    error RetryTooSoon();
    error RetryLimitReached();
    error RequestNotStale();
    error ConfigurationNotReady();
    error RonTransferFailed();
    error OnlyCoordinatorCanFulfill();

    constructor(
        address vaultAddress,
        address coordinatorAddress,
        address initialOwner
    ) Ownable(initialOwner) EIP712("MATT Gift Boxes", "1") {
        if (
            vaultAddress == address(0)
                || coordinatorAddress == address(0)
                || initialOwner == address(0)
        ) revert InvalidAddress();

        vault = IMattGiftBoxVault(vaultAddress);
        vrfCoordinator = IRoninVRFCoordinatorForGiftBoxes(coordinatorAddress);

        uint256[3] memory prices = [uint256(100 ether), uint256(250 ether), uint256(500 ether)];
        uint32[] memory multipliers = new uint32[](10);
        multipliers[0] = 8_500;
        multipliers[1] = 9_000;
        multipliers[2] = 9_500;
        multipliers[3] = 10_000;
        multipliers[4] = 11_000;
        multipliers[5] = 12_500;
        multipliers[6] = 15_000;
        multipliers[7] = 20_000;
        multipliers[8] = 30_000;
        multipliers[9] = 75_000;

        uint16[] memory chances = new uint16[](10);
        chances[0] = 4_000;
        chances[1] = 2_000;
        chances[2] = 1_500;
        chances[3] = 1_500;
        chances[4] = 500;
        chances[5] = 250;
        chances[6] = 150;
        chances[7] = 50;
        chances[8] = 20;
        chances[9] = 30;

        _storeConfiguration(1, prices, multipliers, chances, uint64(block.timestamp));
        activeConfigVersion = 1;
        latestConfigVersion = 1;
        _pause();
        emit ConfigurationActivated(1);
    }

    function purchaseBox(
        address recipient,
        uint8 tier,
        uint256 baseMatt,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external payable whenNotPaused nonReentrant returns (uint256 boxId, bytes32 requestHash) {
        if (
            recipient == address(0)
                || baseMatt == 0
                || baseMatt > type(uint128).max
        ) revert InvalidAmount();
        if (tier >= 3) revert InvalidTier();
        if (block.timestamp > deadline) revert QuoteExpired();
        if (usedNonces[msg.sender][nonce]) revert NonceAlreadyUsed();

        uint256 version = activeConfigVersion;
        Configuration storage config = configurations[version];
        uint256 price = config.prices[tier];
        if (msg.value != price) revert InvalidAmount();

        bytes32 structHash = keccak256(
            abi.encode(
                PRICE_QUOTE_TYPEHASH,
                msg.sender,
                recipient,
                tier,
                baseMatt,
                nonce,
                deadline,
                version
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != owner()) {
            revert InvalidQuote();
        }

        uint256 maximumPayout = _maximumPayout(baseMatt);
        if (vault.availableBankroll() < maximumPayout) revert InsufficientBankroll();

        uint256 randomFee = quoteRandomFee();
        if (address(this).balance < msg.value + randomFee) {
            revert InsufficientRandomnessReserve();
        }

        usedNonces[msg.sender][nonce] = true;
        boxId = nextBoxId++;
        boxes[boxId] = GiftBox({
            buyer: msg.sender,
            recipient: recipient,
            baseMatt: uint128(baseMatt),
            priceRon: uint128(price),
            purchasedAt: uint64(block.timestamp),
            lastRequestAt: uint64(block.timestamp),
            configVersion: uint32(version),
            multiplierBps: 0,
            tier: tier,
            status: STATUS_PENDING,
            retries: 0,
            payout: 0
        });

        vault.reserve(boxId, recipient, maximumPayout);
        requestHash = _requestRandomness(boxId, randomFee);

        (bool sent,) = payable(owner()).call{value: price}("");
        if (!sent) revert RonTransferFailed();

        totalBoxesPurchased += 1;
        totalRonForwarded += price;
        emit BoxPurchased(
            boxId,
            requestHash,
            msg.sender,
            recipient,
            tier,
            price,
            baseMatt,
            version
        );
    }

    function retryRandomness(uint256 boxId) external nonReentrant returns (bytes32 requestHash) {
        GiftBox storage box = boxes[boxId];
        if (box.status == 0) revert InvalidRequest();
        if (box.status != STATUS_PENDING) revert RequestAlreadySettled();
        if (msg.sender != box.buyer && msg.sender != box.recipient && msg.sender != owner()) {
            revert Unauthorized();
        }
        if (box.retries >= MAX_RETRIES) revert RetryLimitReached();
        if (block.timestamp < uint256(box.lastRequestAt) + RETRY_DELAY) revert RetryTooSoon();

        uint256 randomFee = quoteRandomFee();
        if (address(this).balance < randomFee) revert InsufficientRandomnessReserve();

        box.retries += 1;
        box.lastRequestAt = uint64(block.timestamp);
        requestHash = _requestRandomness(boxId, randomFee);
        emit RandomnessRetried(boxId, requestHash, box.retries);
    }

    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed)
        external
        nonReentrant
    {
        if (msg.sender != address(vrfCoordinator)) revert OnlyCoordinatorCanFulfill();
        uint256 boxId = requestToBox[requestHash];
        if (boxId == 0) revert InvalidRequest();

        GiftBox storage box = boxes[boxId];
        if (box.status != STATUS_PENDING) {
            emit LateFulfillmentIgnored(requestHash, boxId);
            return;
        }

        uint32 multiplier = multiplierForRoll(box.configVersion, uint16(randomSeed % BPS));
        uint256 payout = uint256(box.baseMatt) * multiplier / BPS;
        box.status = STATUS_SETTLED;
        box.multiplierBps = multiplier;
        box.payout = payout;

        vault.settle(boxId, payout);
        totalMattAwarded += payout;
        emit BoxSettled(boxId, box.recipient, multiplier, payout);
    }

    function settleStaleBox(uint256 boxId) external nonReentrant {
        GiftBox storage box = boxes[boxId];
        if (box.status == 0) revert InvalidRequest();
        if (box.status != STATUS_PENDING) revert RequestAlreadySettled();
        if (block.timestamp < uint256(box.purchasedAt) + STALE_DELAY) {
            revert RequestNotStale();
        }

        uint256 payout = uint256(box.baseMatt);
        box.status = STATUS_SETTLED;
        box.multiplierBps = uint32(BPS);
        box.payout = payout;

        vault.settle(boxId, payout);
        totalMattAwarded += payout;
        emit StaleBoxSettled(boxId, box.recipient, payout);
    }

    function proposeConfiguration(
        uint256[3] calldata prices,
        uint32[] calldata multipliersBps,
        uint16[] calldata chancesBps
    ) external onlyOwner returns (uint256 version) {
        _validateConfiguration(prices, multipliersBps, chancesBps);
        if (pendingConfigVersion != 0) revert InvalidConfiguration();

        version = ++latestConfigVersion;
        uint64 activatesAt = uint64(block.timestamp + CONFIG_DELAY);
        _storeConfiguration(version, prices, multipliersBps, chancesBps, activatesAt);
        pendingConfigVersion = version;
        emit ConfigurationProposed(version, activatesAt);
    }

    function activateConfiguration(uint256 version) external onlyOwner {
        if (version == 0 || version != pendingConfigVersion) revert InvalidConfiguration();
        Configuration storage config = configurations[version];
        if (!config.exists || block.timestamp < config.activatesAt) revert ConfigurationNotReady();
        activeConfigVersion = version;
        pendingConfigVersion = 0;
        emit ConfigurationActivated(version);
    }

    function cancelPendingConfiguration() external onlyOwner {
        uint256 version = pendingConfigVersion;
        if (version == 0) revert InvalidConfiguration();
        pendingConfigVersion = 0;
        emit ConfigurationCancelled(version);
    }

    function fundRandomnessReserve() external payable onlyOwner {
        if (msg.value == 0) revert InvalidAmount();
        emit RandomnessReserveFunded(msg.sender, msg.value);
    }

    function withdrawRandomnessReserve(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > address(this).balance) revert InvalidAmount();
        (bool sent,) = payable(owner()).call{value: amount}("");
        if (!sent) revert RonTransferFailed();
        emit RandomnessReserveWithdrawn(owner(), amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function quoteRandomFee() public view returns (uint256) {
        return vrfCoordinator.estimateRequestRandomFee(CALLBACK_GAS_LIMIT, fulfillmentGasPrice());
    }

    function fulfillmentGasPrice() public view returns (uint256) {
        return 20 gwei + block.basefee * 2;
    }

    function getConfiguration(uint256 version)
        external
        view
        returns (
            uint256[3] memory prices,
            uint32[] memory multipliersBps,
            uint16[] memory chancesBps,
            uint64 activatesAt,
            bool exists
        )
    {
        Configuration storage config = configurations[version];
        return (
            config.prices,
            config.multipliersBps,
            config.chancesBps,
            config.activatesAt,
            config.exists
        );
    }

    function configurationRtpNumerator(uint256 version) public view returns (uint256 weighted) {
        Configuration storage config = configurations[version];
        if (!config.exists) revert InvalidConfiguration();
        for (uint256 i = 0; i < config.multipliersBps.length; i++) {
            weighted += uint256(config.multipliersBps[i]) * uint256(config.chancesBps[i]);
        }
    }

    function multiplierForRoll(uint256 version, uint16 roll) public view returns (uint32) {
        if (roll >= BPS) revert InvalidAmount();
        Configuration storage config = configurations[version];
        if (!config.exists) revert InvalidConfiguration();

        uint256 cumulative;
        for (uint256 i = 0; i < config.chancesBps.length; i++) {
            cumulative += config.chancesBps[i];
            if (roll < cumulative) return config.multipliersBps[i];
        }
        revert InvalidConfiguration();
    }

    function quoteDigest(
        address buyer,
        address recipient,
        uint8 tier,
        uint256 baseMatt,
        uint256 nonce,
        uint64 deadline,
        uint256 configVersion
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PRICE_QUOTE_TYPEHASH,
                    buyer,
                    recipient,
                    tier,
                    baseMatt,
                    nonce,
                    deadline,
                    configVersion
                )
            )
        );
    }

    function _requestRandomness(uint256 boxId, uint256 fee)
        internal
        returns (bytes32 requestHash)
    {
        requestHash = vrfCoordinator.requestRandomSeed{value: fee}(
            CALLBACK_GAS_LIMIT,
            fulfillmentGasPrice(),
            address(this),
            address(this)
        );
        if (requestHash == bytes32(0) || requestToBox[requestHash] != 0) {
            revert InvalidRequest();
        }
        requestToBox[requestHash] = boxId;
    }

    function _maximumPayout(uint256 baseMatt) internal pure returns (uint256) {
        return (baseMatt * MAX_MULTIPLIER_BPS + BPS - 1) / BPS;
    }

    function _storeConfiguration(
        uint256 version,
        uint256[3] memory prices,
        uint32[] memory multipliersBps,
        uint16[] memory chancesBps,
        uint64 activatesAt
    ) internal {
        Configuration storage config = configurations[version];
        config.prices = prices;
        config.activatesAt = activatesAt;
        config.exists = true;
        for (uint256 i = 0; i < multipliersBps.length; i++) {
            config.multipliersBps.push(multipliersBps[i]);
            config.chancesBps.push(chancesBps[i]);
        }
    }

    function _validateConfiguration(
        uint256[3] memory prices,
        uint32[] memory multipliersBps,
        uint16[] memory chancesBps
    ) internal pure {
        if (
            prices[0] < MIN_BOX_PRICE
                || prices[2] > MAX_BOX_PRICE
                || prices[0] >= prices[1]
                || prices[1] >= prices[2]
                || multipliersBps.length == 0
                || multipliersBps.length > MAX_OUTCOMES
                || multipliersBps.length != chancesBps.length
        ) revert InvalidConfiguration();

        uint256 totalChance;
        uint32 previous;
        for (uint256 i = 0; i < multipliersBps.length; i++) {
            uint32 multiplier = multipliersBps[i];
            if (
                multiplier < MIN_MULTIPLIER_BPS
                    || multiplier > MAX_MULTIPLIER_BPS
                    || chancesBps[i] == 0
                    || (i != 0 && multiplier <= previous)
            ) revert InvalidConfiguration();
            previous = multiplier;
            totalChance += chancesBps[i];
        }
        if (totalChance != BPS) revert InvalidConfiguration();
    }
}
