// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Local-only controlled oracle; never a production observation provider.
contract MockProjectDynoV3Factory {
    address public canonicalPool;
    function setPool(address value) external { canonicalPool = value; }
    function getPool(address, address, uint24) external view returns (address) { return canonicalPool; }
}

contract MockProjectDynoV3Pool {
    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;
    uint128 public liquidity = 1_000_000;
    int24 public meanTick;
    int24 public spotTick;
    uint128 public oracleLiquidity = 1_000_000;
    bool public unavailable;
    bool public malformed;
    bool public unlocked = true;

    constructor(address factory_, address token0_, address token1_, uint24 fee_) {
        factory = factory_; token0 = token0_; token1 = token1_; fee = fee_;
    }
    function configure(int24 mean_, int24 spot_, uint128 harmonic_, uint128 active_, bool unavailable_, bool malformed_, bool unlocked_) external {
        meanTick = mean_; spotTick = spot_; oracleLiquidity = harmonic_; liquidity = active_;
        unavailable = unavailable_; malformed = malformed_; unlocked = unlocked_;
    }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, uint8, bool) {
        // Real-shaped Katana protocol fee fields catch seven-word ABI mistakes.
        return (uint160(1 << 96), spotTick, 0, 2, 2, 15, 100, unlocked);
    }
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory ticks, uint160[] memory liquidities) {
        require(!unavailable, "LOCAL_HISTORY_UNAVAILABLE");
        uint256 length = malformed ? 1 : 2;
        ticks = new int56[](length); liquidities = new uint160[](length);
        if (malformed) return (ticks, liquidities);
        ticks[1] = int56(meanTick) * int56(uint56(secondsAgos[0]));
        if (oracleLiquidity != 0) liquidities[1] = uint160((uint256(secondsAgos[0]) << 128) / oracleLiquidity);
    }
}
