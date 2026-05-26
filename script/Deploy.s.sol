// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy}    from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {RobetNFT}      from "../src/RobetNFT.sol";
import {PriceFeed}     from "../src/PriceFeed.sol";
import {BetPool}       from "../src/BetPool.sol";
import {Staking}       from "../src/Staking.sol";
import {MockPriceFeed} from "../src/mocks/MockPriceFeed.sol";

// Named proxy wrapper so the BetPool proxy has a unique contractName in the
// Foundry broadcast JSON (deploy.ts looks it up by name to patch .env).
// RobetNFT is non-upgradeable so it needs no wrapper.
contract BetPoolProxy is ERC1967Proxy { constructor(address i, bytes memory d) ERC1967Proxy(i, d) {} }

/// @notice Full mainnet deployment in one broadcast.
///
/// Flow (single broadcast, signed by the hot DEPLOYER_PRIVATE_KEY):
///   1. Deploy RobetNFT with deployer as the temporary owner (so it can call
///      setMinter on itself further down).
///   2. Deploy PriceFeed (or reuse the address already in env, if it has code).
///   3. Deploy BetPool proxy, initialized with the cold OWNER_ADDRESS.
///   4. Deploy Staking, owner = cold OWNER_ADDRESS.
///   5. nft.setMinter(staking) - Staking becomes the sole NFT minter.
///   6. nft.transferOwnership(OWNER_ADDRESS) - deployer has zero privileges
///      from this point. Cold wallet now controls every contract.
///
/// The deployer key never holds ownership of anything after this script
/// completes.
contract Deploy is Script {
    address constant MAINNET_RON_WETH_POOL  = 0x2ECb08F87F075b5769Fe543d0e52e40140575ea7;
    address constant MAINNET_WETH_USDC_POOL = 0xA7964991f339668107E2b6A6f6b8e8B74Aa9D017;
    address constant MAINNET_WRON           = 0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4;

    uint256 constant CHAIN_RONIN = 2020;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address owner       = vm.envOr("OWNER_ADDRESS", deployer);
        address treasury    = vm.envOr("TREASURY_ADDRESS", deployer);

        console.log("Chain ID: ", block.chainid);
        console.log("Deployer: ", deployer);
        console.log("Owner:    ", owner);
        console.log("Treasury: ", treasury);
        console.log("---");

        vm.startBroadcast(deployerKey);

        // 1. RobetNFT (non-upgradeable). Deployer is the temporary owner so
        //    it can call setMinter() once Staking has been deployed. Ownership
        //    is handed off to the cold wallet at the end of this broadcast.
        //
        //    URIs are env-overridable; empty values are fine, the owner can
        //    update them later via setBaseURI / setContractURI.
        string memory nftBaseURI     = vm.envOr("NFT_BASE_URI",     string(""));
        string memory nftContractURI = vm.envOr("NFT_CONTRACT_URI", string(""));
        RobetNFT robetNft = new RobetNFT(deployer, nftBaseURI, nftContractURI);

        // 2. PriceFeed - reuse if PRICE_FEED_ADDRESS env points to deployed code.
        //    Swap live at any time via betPool.setFeed(newAddress).
        address priceFeedAddr = vm.envOr("PRICE_FEED_ADDRESS", address(0));
        if (priceFeedAddr != address(0) && priceFeedAddr.code.length > 0) {
            console.log("Reusing existing PriceFeed:", priceFeedAddr);
        } else {
            if (priceFeedAddr != address(0)) {
                console.log("PRICE_FEED_ADDRESS set but no contract found - deploying fresh.");
            }
            if (block.chainid == CHAIN_RONIN) {
                priceFeedAddr = address(new PriceFeed(
                    MAINNET_RON_WETH_POOL, MAINNET_WETH_USDC_POOL, MAINNET_WRON
                ));
            } else {
                priceFeedAddr = address(new MockPriceFeed(3.200e18));
            }
        }

        // 3. BetPool proxy - owner set directly to the cold wallet at init.
        BetPool betPoolImpl = new BetPool();
        BetPool betPool = BetPool(payable(address(new BetPoolProxy(
            address(betPoolImpl),
            abi.encodeCall(betPoolImpl.initialize, (
                owner,
                address(robetNft),
                priceFeedAddr,
                treasury
            ))
        ))));

        // 4. Staking (non-upgradeable) - owner set directly to the cold wallet.
        //    All five knobs env-overridable so local tests can run with small values.
        uint256 stakingMinStake     = vm.envOr("STAKING_MIN_STAKE_RON",     uint256(1_000))  * 1 ether;
        uint256 stakingNftThreshold = vm.envOr("STAKING_NFT_THRESHOLD_RON", uint256(10_000)) * 1 ether;
        uint256 stakingLockSec      = vm.envOr("STAKING_LOCK_SECONDS",      uint256(1 days));
        uint256 stakingYearSec      = vm.envOr("STAKING_YEAR_SECONDS",      uint256(365 days));
        uint256 stakingBaseProbBps  = vm.envOr("STAKING_BASE_PROB_BPS",     uint256(500));
        Staking staking = new Staking(
            address(robetNft),
            stakingMinStake, stakingNftThreshold, stakingLockSec, stakingYearSec, stakingBaseProbBps
        );

        // 5. Wire Staking as the sole minter on the NFT (must happen while
        //    deployer still owns RobetNFT).
        robetNft.setMinter(address(staking));

        // 6. Transfer NFT ownership to the cold wallet. Deployer no longer has
        //    any privileges - only the cold wallet can rotate the minter or
        //    upgrade BetPool from here.
        robetNft.transferOwnership(owner);

        vm.stopBroadcast();

        console.log("RobetNFT: ", address(robetNft));
        console.log("PriceFeed:", priceFeedAddr);
        console.log("BetPool:  ", address(betPool));
        console.log("Staking:  ", address(staking));
        console.log("---");
        console.log("RobetNFT minter set to Staking.");
        console.log("RobetNFT ownership transferred to:", owner);
        console.log("Run 'cd script && npm run deploy' to patch .env automatically.");
    }
}
