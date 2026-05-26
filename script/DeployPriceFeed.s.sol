// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PriceFeed}       from "../src/PriceFeed.sol";

/// @notice Step 1 of mainnet deployment.
///         Deploys PriceFeed and prints the current RON/USD price so you can
///         verify it looks correct before committing to the full deploy.
///
/// Usage:
///   forge script script/DeployPriceFeed.s.sol:DeployPriceFeed \
///     --rpc-url https://api.roninchain.com/rpc --broadcast --slow
///
/// After verifying the price, set PRICE_FEED_ADDRESS=<addr> in .env and run
/// the main deploy (step 2):
///   cd script && npm run deploy -- --chain mainnet
contract DeployPriceFeed is Script {
    address constant RON_WETH_POOL  = 0x2ECb08F87F075b5769Fe543d0e52e40140575ea7;
    address constant WETH_USDC_POOL = 0xA7964991f339668107E2b6A6f6b8e8B74Aa9D017;
    address constant WRON           = 0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        PriceFeed feed = new PriceFeed(RON_WETH_POOL, WETH_USDC_POOL, WRON);
        vm.stopBroadcast();

        uint256 price = feed.ronPriceUsd1e18();
        console.log("PriceFeed deployed:", address(feed));
        console.log("RON/USD (raw 1e18):", price);
        // Print as $X.XXX - divide by 1e15 to get the 3-decimal integer
        console.log("RON/USD ($0.001 units):", price / 1e15);
        console.log("---");
        console.log("If the price looks right, add to .env:");
        console.log("  PRICE_FEED_ADDRESS=<address above>");
        console.log("  NEXT_PUBLIC_PRICE_FEED=<address above>");
        console.log("Then run: cd script && npm run deploy -- --chain mainnet");
    }
}
