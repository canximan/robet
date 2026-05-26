// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Fixed-price feed for local development and Saigon testnet.
///         Owner sets the price manually; keeper bumps it ±3–8% after each
///         snapshot so games don't always tie-refund.
/// @dev Not upgradeable - swap via BetPool.setFeed(newAddress) if needed.
contract MockPriceFeed {
    uint256 public price;
    address public immutable owner;

    constructor(uint256 _initialPrice) {
        price = _initialPrice;
        owner = msg.sender;
    }

    function setPrice(uint256 _price) external {
        require(msg.sender == owner, "not owner");
        price = _price;
    }

    /// @notice Returns the fixed mock price. No truncation - owner is expected
    ///         to set values already rounded to $0.001 (e.g. 3.200e18).
    function ronPriceUsd1e18() external view returns (uint256) {
        return price;
    }
}
