// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVRFCoordinatorV2PlusForMattSlots {
    struct RandomWordsRequest { bytes32 keyHash; uint256 subId; uint16 requestConfirmations; uint32 callbackGasLimit; uint32 numWords; bytes extraArgs; }
    function requestRandomWords(RandomWordsRequest calldata request) external returns (uint256 requestId);
}
interface IMattSlotsRandomSeedConsumer { function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed) external; }

/// @title MATT Slots VRF V2.5 Adapter
/// @notice Pays VRF from a native-RON subscription while preserving the audited Slots callback.
contract MattSlotsVRFV25Adapter is Ownable2Step, ReentrancyGuard {
    bytes4 private constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));
    struct Request { address consumer; bytes32 legacyRequestHash; uint256 randomWord; bool fulfilled; bool delivered; }

    IVRFCoordinatorV2PlusForMattSlots public immutable vrfCoordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    uint32 public immutable maximumConsumerCallbackGasLimit;
    address public consumer;
    uint256 public outstandingRequests;
    mapping(uint256 requestId => Request request) public requests;
    mapping(bytes32 legacyRequestHash => uint256 requestId) public requestIds;

    event ConsumerConfigured(address indexed consumer);
    event RandomSeedRequested(uint256 indexed requestId, bytes32 indexed legacyRequestHash, address indexed consumer);
    event RandomSeedReceived(uint256 indexed requestId, uint256 randomWord);
    event RandomSeedDelivery(uint256 indexed requestId, bytes32 indexed legacyRequestHash, bool success);
    error Unauthorized(); error InvalidAddress(); error InvalidConfiguration(); error InvalidRequest();
    error UnexpectedValue(); error ConsumerAlreadyConfigured(); error RequestAlreadyFulfilled(); error RequestNotReady();

    constructor(address coordinatorAddress,uint256 vrfSubscriptionId,bytes32 provingKeyHash,address initialOwner,uint16 minimumConfirmations,uint32 coordinatorCallbackGasLimit,uint32 maximumSlotsCallbackGasLimit) Ownable(initialOwner) {
        if (coordinatorAddress == address(0) || coordinatorAddress.code.length == 0 || initialOwner == address(0)) revert InvalidAddress();
        if (vrfSubscriptionId == 0 || provingKeyHash == bytes32(0) || minimumConfirmations == 0 || coordinatorCallbackGasLimit == 0 || maximumSlotsCallbackGasLimit == 0 || coordinatorCallbackGasLimit <= maximumSlotsCallbackGasLimit) revert InvalidConfiguration();
        vrfCoordinator = IVRFCoordinatorV2PlusForMattSlots(coordinatorAddress); subscriptionId = vrfSubscriptionId; keyHash = provingKeyHash;
        requestConfirmations = minimumConfirmations; callbackGasLimit = coordinatorCallbackGasLimit; maximumConsumerCallbackGasLimit = maximumSlotsCallbackGasLimit;
    }

    function setConsumer(address newConsumer) external onlyOwner {
        if (consumer != address(0)) revert ConsumerAlreadyConfigured();
        if (newConsumer == address(0) || newConsumer.code.length == 0) revert InvalidAddress();
        consumer = newConsumer; emit ConsumerConfigured(newConsumer);
    }
    function estimateRequestRandomFee(uint256, uint256) external pure returns (uint256) { return 0; }

    function requestRandomSeed(uint256 consumerCallbackGasLimit,uint256,address requestedConsumer,address) external payable nonReentrant returns (bytes32 legacyRequestHash) {
        address configuredConsumer = consumer;
        if (msg.sender != configuredConsumer || requestedConsumer != configuredConsumer) revert Unauthorized();
        if (msg.value != 0) revert UnexpectedValue();
        if (consumerCallbackGasLimit == 0 || consumerCallbackGasLimit > maximumConsumerCallbackGasLimit) revert InvalidConfiguration();
        uint256 requestId = vrfCoordinator.requestRandomWords(IVRFCoordinatorV2PlusForMattSlots.RandomWordsRequest({
            keyHash: keyHash, subId: subscriptionId, requestConfirmations: requestConfirmations, callbackGasLimit: callbackGasLimit,
            numWords: 1, extraArgs: abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, true)
        }));
        if (requestId == 0 || requests[requestId].consumer != address(0)) revert InvalidRequest();
        legacyRequestHash = bytes32(requestId);
        requests[requestId] = Request(configuredConsumer, legacyRequestHash, 0, false, false);
        requestIds[legacyRequestHash] = requestId; outstandingRequests += 1;
        emit RandomSeedRequested(requestId, legacyRequestHash, configuredConsumer);
    }

    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external nonReentrant {
        if (msg.sender != address(vrfCoordinator)) revert Unauthorized();
        Request storage request = requests[requestId];
        if (request.consumer == address(0) || randomWords.length != 1) revert InvalidRequest();
        if (request.fulfilled) revert RequestAlreadyFulfilled();
        request.fulfilled = true; request.randomWord = randomWords[0];
        emit RandomSeedReceived(requestId, randomWords[0]); _tryDelivery(requestId, request);
    }
    function retryFulfillment(uint256 requestId) external nonReentrant returns (bool delivered) {
        Request storage request = requests[requestId];
        if (!request.fulfilled || request.delivered) revert RequestNotReady();
        delivered = _tryDelivery(requestId, request);
    }
    function _tryDelivery(uint256 requestId, Request storage request) internal returns (bool success) {
        (success,) = request.consumer.call(abi.encodeCall(IMattSlotsRandomSeedConsumer.rawFulfillRandomSeed,(request.legacyRequestHash, request.randomWord)));
        if (success) { request.delivered = true; outstandingRequests -= 1; }
        emit RandomSeedDelivery(requestId, request.legacyRequestHash, success);
    }
}