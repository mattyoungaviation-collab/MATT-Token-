// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockProjectDynoSwapAdapter {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    uint256 public saleRonPerTicket;
    uint256 public mattPerRon;
    bool public failSales;
    bool public failBuys;
    bytes32 public constant routeHash = keccak256("LOCAL_MOCK_FIXED_ROUTE");

    constructor(address matt_, uint256 saleRonPerTicket_, uint256 mattPerRon_) {
        token = IERC20(matt_);
        saleRonPerTicket = saleRonPerTicket_;
        mattPerRon = mattPerRon_;
    }

    function matt() external view returns (address) { return address(token); }
    function configure(uint256 saleRonPerTicket_, uint256 mattPerRon_, bool failSales_, bool failBuys_) external {
        saleRonPerTicket = saleRonPerTicket_;
        mattPerRon = mattPerRon_;
        failSales = failSales_;
        failBuys = failBuys_;
    }

    function sellExactMatt(uint256 amountIn, uint256 minRonOut) external returns (uint256 ronOut) {
        require(!failSales, "SALE_FAILED");
        token.safeTransferFrom(msg.sender, address(this), amountIn);
        ronOut = saleRonPerTicket;
        require(ronOut >= minRonOut, "MIN_OUT");
        (bool ok,) = payable(msg.sender).call{value: ronOut}("");
        require(ok, "RON_SEND");
    }

    function buyMatt(address recipient, uint256 minMattOut) external payable returns (uint256 mattOut) {
        require(!failBuys, "BUY_FAILED");
        mattOut = msg.value * mattPerRon / 1 ether;
        require(mattOut >= minMattOut, "MIN_OUT");
        token.safeTransfer(recipient, mattOut);
    }

    receive() external payable {}
}
