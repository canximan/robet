// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPriceFeed {
    /// @notice RON/USD price scaled to 1e18, truncated to 3 decimal places.
    function ronPriceUsd1e18() external view returns (uint256);
}
