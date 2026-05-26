// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test}          from "forge-std/Test.sol";
import {PriceFeed}     from "../src/PriceFeed.sol";
import {IKatanaV2Pair} from "../src/interfaces/IKatanaV2Pair.sol";

/// @notice Fork test for PriceFeed. Run with:
///   forge test --fork-url $RONIN_RPC_URL --match-contract PriceFeedTest -vvv
contract PriceFeedTest is Test {
    address constant RON_WETH_POOL  = 0x2ECb08F87F075b5769Fe543d0e52e40140575ea7;
    address constant WETH_USDC_POOL = 0xA7964991f339668107E2b6A6f6b8e8B74Aa9D017;
    address constant WRON           = 0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4;

    PriceFeed feed;

    function setUp() public {
        feed = new PriceFeed(RON_WETH_POOL, WETH_USDC_POOL, WRON);
    }

    function test_tokenOrderDetected() public view {
        bool ronIs0 = IKatanaV2Pair(RON_WETH_POOL).token0() == WRON;
        assertEq(feed.ronIsToken0InRonWeth(), ronIs0);

        address weth = ronIs0 ? IKatanaV2Pair(RON_WETH_POOL).token1()
                              : IKatanaV2Pair(RON_WETH_POOL).token0();
        assertEq(feed.wethIsToken0InWethUsdc(), IKatanaV2Pair(WETH_USDC_POOL).token0() == weth);
    }

    function test_priceInPlausibleRange() public {
        uint256 price = feed.ronPriceUsd1e18();
        // Price is truncated to $0.001 granularity - verify it's a multiple of 1e15.
        assertEq(price % 1e15, 0, "price not truncated to 3 decimals");
        assertGt(price, 0.1e18, "price too low");
        assertLt(price, 20e18,  "price too high");
        emit log_named_decimal_uint("RON/USD", price, 18);
    }
}
