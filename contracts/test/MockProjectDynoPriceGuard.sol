// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockProjectDynoPriceGuard {
    uint256 public saleQuote;
    uint256 public mattPerRon;
    bool public valid = true;

    constructor(uint256 saleQuote_, uint256 mattPerRon_) {
        saleQuote = saleQuote_;
        mattPerRon = mattPerRon_;
    }

    function setQuotes(uint256 saleQuote_, uint256 mattPerRon_) external { saleQuote = saleQuote_; mattPerRon = mattPerRon_; }
    function setValid(bool value) external { valid = value; }
    function validate() external view { require(valid, "GUARD_INVALID"); }
    function saleMinOut(uint256, uint16 slippageBps) external view returns (uint256) { return saleQuote * (10_000 - slippageBps) / 10_000; }
    function buybackMinOut(uint256 ronIn, uint16 slippageBps) external view returns (uint256) { return ronIn * mattPerRon / 1 ether * (10_000 - slippageBps) / 10_000; }
}
