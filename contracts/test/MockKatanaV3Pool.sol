// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockKatanaV3Pool {
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint128 public liquidity;
    int24 public meanTick;
    uint128 public harmonicLiquidity;
    uint16 public observationCardinality = 2;
    uint16 public observationCardinalityNext = 2;

    constructor(
        address factory_,
        address token0_,
        address token1_,
        int24 meanTick_,
        uint128 liquidity_
    ) {
        factory = factory_;
        token0 = token0_;
        token1 = token1_;
        meanTick = meanTick_;
        liquidity = liquidity_;
        harmonicLiquidity = liquidity_;
    }

    function setOracle(int24 newMeanTick, uint128 newHarmonicLiquidity) external {
        meanTick = newMeanTick;
        harmonicLiquidity = newHarmonicLiquidity;
    }

    function setLiquidity(uint128 newLiquidity) external {
        liquidity = newLiquidity;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (
            uint160(1 << 96),
            meanTick,
            0,
            observationCardinality,
            observationCardinalityNext,
            0,
            true
        );
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        )
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s =
            new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; i++) {
            uint32 ago = secondsAgos[i];
            tickCumulatives[i] =
                -int56(meanTick) * int56(uint56(ago));
            if (ago != 0) {
                uint256 delta = uint256(ago) * type(uint160).max
                    / (uint256(harmonicLiquidity) << 32);
                secondsPerLiquidityCumulativeX128s[i] =
                    type(uint160).max - uint160(delta);
            } else {
                secondsPerLiquidityCumulativeX128s[i] =
                    type(uint160).max;
            }
        }
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) {
            observationCardinalityNext = next;
        }
    }
}
