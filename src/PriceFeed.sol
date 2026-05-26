// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IKatanaV2Pair} from "./interfaces/IKatanaV2Pair.sol";

/// @title PriceFeed
/// @notice Two-hop spot price: RON/USD = (WRON/WETH) × (WETH/USDC) from Katana V2 pools.
///         Result is scaled to 1e18 and truncated to 3 decimal places ($0.001 granularity).
///
///         Truncation to $0.001 raises the cost of price manipulation:
///         an attacker must move pool reserves by ≥$0.001 (vs $0.0001 with 4 decimals)
///         to influence a snapshot/resolve comparison in BetPool.
///
///         Stateless after construction. Swap via BetPool.setFeed(newAddress) if logic
///         must change - no proxy needed on the feed itself.
contract PriceFeed {
    IKatanaV2Pair public immutable ronWethPool;
    IKatanaV2Pair public immutable wethUsdcPool;

    bool public immutable ronIsToken0InRonWeth;
    bool public immutable wethIsToken0InWethUsdc;

    constructor(address _ronWethPool, address _wethUsdcPool, address _wron) {
        ronWethPool  = IKatanaV2Pair(_ronWethPool);
        wethUsdcPool = IKatanaV2Pair(_wethUsdcPool);

        bool ronIs0 = IKatanaV2Pair(_ronWethPool).token0() == _wron;
        ronIsToken0InRonWeth = ronIs0;

        address weth = ronIs0 ? IKatanaV2Pair(_ronWethPool).token1()
                              : IKatanaV2Pair(_ronWethPool).token0();
        wethIsToken0InWethUsdc = IKatanaV2Pair(_wethUsdcPool).token0() == weth;
    }

    /// @notice Returns the RON price in USD scaled to 1e18, truncated to 3 decimal places.
    ///         E.g. $3.2047 → 3.204e18 (sub-$0.001 noise zeroed out).
    function ronPriceUsd1e18() external view returns (uint256) {
        (uint112 r0a, uint112 r1a,) = ronWethPool.getReserves();
        uint256 ronRes  = ronIsToken0InRonWeth ? uint256(r0a) : uint256(r1a);
        uint256 wethRes = ronIsToken0InRonWeth ? uint256(r1a) : uint256(r0a);
        uint256 wethPerRon = wethRes * 1e18 / ronRes;

        (uint112 r0b, uint112 r1b,) = wethUsdcPool.getReserves();
        uint256 wethR = wethIsToken0InWethUsdc ? uint256(r0b) : uint256(r1b);
        uint256 usdcR = wethIsToken0InWethUsdc ? uint256(r1b) : uint256(r0b);
        // USDC is 6-decimal; ×1e12 brings it to 18-decimal space before dividing.
        uint256 usdPerWeth = usdcR * 1e12 * 1e18 / wethR;

        uint256 price = wethPerRon * usdPerWeth / 1e18;

        // Floor to nearest $0.001: zeroes the sub-$0.001 fraction.
        // solhint-disable-next-line divide-before-multiply
        return (price / 1e15) * 1e15; // intentional truncation, not accidental precision loss
    }
}
