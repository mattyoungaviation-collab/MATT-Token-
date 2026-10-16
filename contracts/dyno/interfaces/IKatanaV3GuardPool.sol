// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev DYNO-specific Katana interface; existing game interfaces are unchanged.
/// Katana has TWO protocol fee fields, unlike the Uniswap seven-word slot0.
/// Official source: ronin-chain/katana-v3-contracts mainnet IKatanaV3PoolState.
interface IKatanaV3GuardPool {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function fee() external view returns (uint24);
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
        uint16 observationCardinality, uint16 observationCardinalityNext,
        uint8 feeProtocolNum, uint8 feeProtocolDen, bool unlocked
    );
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

interface IKatanaV3GuardFactory {
    function getPool(address token0, address token1, uint24 fee) external view returns (address);
}
