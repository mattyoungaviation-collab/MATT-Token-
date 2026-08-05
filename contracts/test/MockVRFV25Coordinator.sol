// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVRFV25AdapterCallback {
    function rawFulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external;
}

interface IVRFV25AdapterRequest {
    function requestRandomSeed(
        uint256 consumerCallbackGasLimit,
        uint256 gasPrice,
        address consumer,
        address refundAddress
    ) external payable returns (bytes32 requestHash);
}

contract MockVRFV25Coordinator {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    uint256 public lastRequestId;
    mapping(uint256 requestId => address requester) public requesters;

    function requestRandomWords(RandomWordsRequest calldata)
        external
        returns (uint256 requestId)
    {
        requestId = ++lastRequestId;
        requesters[requestId] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = randomWord;
        IVRFV25AdapterCallback(requesters[requestId]).rawFulfillRandomWords(
            requestId,
            randomWords
        );
    }
}

contract MockSlotsSeedConsumer {
    address public immutable adapter;
    bytes32 public lastRequestHash;
    bytes32 public fulfilledRequestHash;
    uint256 public fulfilledRandomSeed;
    bool public shouldRevert;

    error Unauthorized();
    error DeliveryRejected();

    constructor(address adapterAddress) {
        adapter = adapterAddress;
    }

    function request(uint256 callbackGasLimit)
        external
        payable
        returns (bytes32 requestHash)
    {
        requestHash = IVRFV25AdapterRequest(adapter).requestRandomSeed{
            value: msg.value
        }(callbackGasLimit, 0, address(this), address(this));
        lastRequestHash = requestHash;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function rawFulfillRandomSeed(bytes32 requestHash, uint256 randomSeed)
        external
    {
        if (msg.sender != adapter) revert Unauthorized();
        if (shouldRevert) revert DeliveryRejected();
        fulfilledRequestHash = requestHash;
        fulfilledRandomSeed = randomSeed;
    }
}