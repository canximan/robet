// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Staking}         from "../src/Staking.sol";

/// @notice Deploys ONLY the Staking contract - for redeploying a v2 staking
///         alongside an already-live RobetNFT. The full first-time deploy
///         (NFT + PriceFeed + BetPool + Staking + setMinter + transferOwnership)
///         is handled by Deploy.s.sol in a single broadcast.
///
/// Required env:
///   DEPLOYER_PRIVATE_KEY   hot key - pays gas only
///   OWNER_ADDRESS          cold wallet - becomes Staking owner immediately
///   ROBET_NFT_ADDRESS      existing RobetNFT contract
///
/// Run:
///   forge script script/DeployStaking.s.sol:DeployStaking \
///     --rpc-url https://api.roninchain.com/rpc --broadcast --slow
///
/// After deploy, the cold-wallet OWNER must point RobetNFT at the new Staking:
///   cast send <ROBET_NFT_ADDRESS> "setMinter(address)" <STAKING_ADDRESS> \
///     --private-key <OWNER_KEY> --rpc-url <RPC>
///
/// Without that step, claimAndRestake() reverts ("only minter").
contract DeployStaking is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address robetNft    = vm.envAddress("ROBET_NFT_ADDRESS");

        console.log("Chain ID: ", block.chainid);
        console.log("Deployer: ", deployer);
        console.log("RobetNFT: ", robetNft);
        console.log("---");

        // All five knobs env-overridable; defaults are production values.
        uint256 minStake     = vm.envOr("STAKING_MIN_STAKE_RON",     uint256(1_000))  * 1 ether;
        uint256 nftThreshold = vm.envOr("STAKING_NFT_THRESHOLD_RON", uint256(10_000)) * 1 ether;
        uint256 lockSec      = vm.envOr("STAKING_LOCK_SECONDS",      uint256(1 days));
        uint256 yearSec      = vm.envOr("STAKING_YEAR_SECONDS",      uint256(365 days));
        uint256 baseProbBps  = vm.envOr("STAKING_BASE_PROB_BPS",     uint256(500));
        console.log("MIN_STAKE wei:     ", minStake);
        console.log("NFT_THRESHOLD wei: ", nftThreshold);
        console.log("LOCK seconds:      ", lockSec);
        console.log("YEAR seconds:      ", yearSec);
        console.log("BASE_PROB_BPS:     ", baseProbBps);

        vm.startBroadcast(deployerKey);
        Staking staking = new Staking(robetNft, minStake, nftThreshold, lockSec, yearSec, baseProbBps);
        vm.stopBroadcast();

        console.log("Staking:  ", address(staking));
        console.log("---");
        console.log("NEXT: owner must call robetNft.setMinter(staking) from the cold wallet.");
        console.log("Set STAKING_ADDRESS + NEXT_PUBLIC_STAKING in .env after this completes.");
    }
}
