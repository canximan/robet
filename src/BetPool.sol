// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable}      from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable}    from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {RobetNFT}           from "./RobetNFT.sol";
import {IPriceFeed}         from "./interfaces/IPriceFeed.sol";

/// @title BetPool
/// @notice Auto-cycling LONG/SHORT game on RON price. Handles both betting logic
///         and PoD reward distribution (MasterChef-style accumulator, no iteration).
///
/// Game cycle (Ronin ~3 s/block):
///   |<- BETTING_BLOCKS (1 200) ->|<- HOLD_BLOCKS (1 200) ->|
///   ^bettingOpen(N)               ^bettingClose(N)          ^resolutionBlock(N)
///
/// Fee flow:
///   • 0.1 RON entry fee per bet (non-NFT holders only) → treasury wallet
///   • 2% of losing pot on resolve → treasury wallet
///   (PoD treasury cut is handled externally by the sweeper before forwarding here)
///
/// Price: delegated to an external IPriceFeed (PriceFeed on mainnet, MockPriceFeed
///        on local/testnet). Swap live via setFeed(newAddress) without upgrading.
///
/// Upgradeable via UUPS (ERC-1967).
contract BetPool is Initializable, OwnableUpgradeable, UUPSUpgradeable {

    // ── Types ────────────────────────────────────────────────────────────────

    enum Side   { LONG, SHORT }
    enum Status { OPEN, RESOLVED, REFUNDED, EXPIRED }

    struct Game {
        uint256 snapshotPrice;
        uint256 resolvedPrice;
        uint256 totalLongStake;
        uint256 totalShortStake;
        uint256 feeCollected;
        Status  status;
        Side    winningSide;
    }

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant SNAPSHOT_WINDOW    = 10;
    uint256 public constant RESOLUTION_WINDOW  = 30;
    uint256 public constant POT_FEE_BPS        = 200;    // 2% of losing pot → treasury
    uint256 public constant BPS_DENOM          = 10_000;
    uint256 public constant MAX_STAKE_PER_SIDE = 5_000_000 ether;
    uint256 public constant MIN_BET            = 0.01 ether;
    uint256 public constant ENTRY_FEE          = 0.1 ether; // non-NFT holders only → treasury

    // PoD split: 80% losers / 20% winners.
    // Treasury cut is taken by the sweeper before forwarding RON here.
    uint256 public constant LOSER_BPS  = 8_000;
    uint256 public constant WINNER_BPS = 2_000;

    // ── Storage ──────────────────────────────────────────────────────────────

    uint256 public GENESIS_BLOCK;

    // Window sizes - owner-adjustable via setBlocks().
    // Changing them resets GENESIS_BLOCK so the cycle restarts cleanly.
    // Only call setBlocks() when no active bets exist on the current game.
    uint256 public BETTING_BLOCKS;
    uint256 public HOLD_BLOCKS;

    RobetNFT public nft;

    /// @notice Wallet that receives entry fees and 2% pot fees.
    address public treasury;

    /// @notice Price feed (PriceFeed on mainnet, MockPriceFeed on local/testnet).
    ///         Swap without a full contract upgrade via setFeed(newAddress).
    address public feed;

    // ── Game state ────────────────────────────────────────────────────────────

    mapping(uint256 => Game) public games;
    mapping(uint256 => mapping(address => mapping(Side => uint256))) public userStake;
    mapping(uint256 => mapping(address => bool)) public claimed;

    // ── PoD reward accumulator ─────────────────────────────────────────────────
    //
    // Scaled by 1e18 to preserve precision for small per-unit amounts.
    // accXxxRewardPerUnit grows monotonically with every PoD inflow.
    // betXxxSnapshot[betId] records the accumulator value at bet resolution time.
    // A user's share = userAmount * (accNow - snapshotAtResolution) / 1e18.
    // Only PoD arriving AFTER a game resolves accrues to that game's participants.

    uint256 public accLoserRewardPerUnit;
    uint256 public accWinRewardPerUnit;

    uint256 public totalCumulativeLoss;
    uint256 public totalCumulativeWin;
    uint256 public totalReceived;

    mapping(uint256 => uint256) public betLoserSnapshot;
    mapping(uint256 => uint256) public betWinnerSnapshot;

    mapping(uint256 => mapping(address => bool)) public loserClaimed;
    mapping(uint256 => mapping(address => bool)) public winnerClaimed;

    // ── Events ───────────────────────────────────────────────────────────────

    event Bet(uint256 indexed gameId, address indexed user, Side side, uint256 amount);
    event Snapshot(uint256 indexed gameId, uint256 snapshotPrice);
    event Resolved(uint256 indexed gameId, Side winningSide, uint256 resolvedPrice);
    event Refunded(uint256 indexed gameId);
    event Expired(uint256 indexed gameId);
    event Claimed(uint256 indexed gameId, address indexed user, uint256 amount);

    event RewardReceived(uint256 amount, uint256 loserShare, uint256 winnerShare);
    event BetRegistered(uint256 indexed betId, uint256 loserTotal, uint256 winnerTotal);
    event LoserRebateClaimed(uint256 indexed betId, address indexed user, uint256 amount);
    event WinnerBonusClaimed(uint256 indexed betId, address indexed user, uint256 amount);

    // ── Errors ───────────────────────────────────────────────────────────────

    error InsufficientEntryFee();
    error BettingClosed();
    error BettingNotClosed();
    error BelowMinBet();
    error ExceedsMaxStake();
    error SnapshotAlreadyTaken();
    error SnapshotWindowMissed();
    error SnapshotWindowNotClosed();
    error ResolutionBlockNotReached();
    error AlreadyResolved();
    error AlreadyClaimed();
    error NothingToClaim();
    error TransferFailed();

    // ── Initializer ──────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _owner, address _nft, address _feed, address _treasury) external initializer {
        __Ownable_init(_owner);
        nft           = RobetNFT(_nft);
        feed          = _feed;
        treasury      = _treasury;
        BETTING_BLOCKS = 1_200;  // 1 h @ Ronin ~3 s/block
        HOLD_BLOCKS    = 1_200;  // 1 h hold window
        GENESIS_BLOCK  = block.number;
    }

    // ── Admin setters ─────────────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    /// @notice Swap the price feed without a full upgrade - e.g. after verifying
    ///         a new PriceFeed on mainnet or switching from mock to live.
    function setFeed(address _feed) external onlyOwner {
        feed = _feed;
    }

    /// @notice Resize the betting and hold windows, then restart the game cycle
    ///         from the current block. Call only when the current game has no active
    ///         bets - there is no on-chain enforcement, owner takes responsibility.
    ///
    ///         Minimum: BETTING_BLOCKS > SNAPSHOT_WINDOW (10) so the keeper has
    ///         time to capture the price. HOLD_BLOCKS > RESOLUTION_WINDOW (30)
    ///         so the keeper has time to call resolve().
    function setBlocks(uint256 _bettingBlocks, uint256 _holdBlocks) external onlyOwner {
        require(_bettingBlocks > SNAPSHOT_WINDOW,   "betting window too short");
        require(_holdBlocks    > RESOLUTION_WINDOW, "hold window too short");
        BETTING_BLOCKS = _bettingBlocks;
        HOLD_BLOCKS    = _holdBlocks;
        GENESIS_BLOCK  = block.number; // restart cycle; new game #0 begins now
    }

    // ── Timing views ─────────────────────────────────────────────────────────

    function currentGameId() public view returns (uint256) {
        if (block.number < GENESIS_BLOCK) return 0;
        return (block.number - GENESIS_BLOCK) / BETTING_BLOCKS;
    }

    function bettingOpenBlock(uint256 gameId) public view returns (uint256) {
        return GENESIS_BLOCK + gameId * BETTING_BLOCKS;
    }

    function bettingCloseBlock(uint256 gameId) public view returns (uint256) {
        return GENESIS_BLOCK + (gameId + 1) * BETTING_BLOCKS;
    }

    function resolutionBlock(uint256 gameId) public view returns (uint256) {
        return bettingCloseBlock(gameId) + HOLD_BLOCKS;
    }

    // ── Game write functions ──────────────────────────────────────────────────

    function bet(uint256 gameId, Side side) external payable {
        uint256 openBlock  = bettingOpenBlock(gameId);
        uint256 closeBlock = bettingCloseBlock(gameId);
        if (block.number < openBlock || block.number >= closeBlock) revert BettingClosed();

        uint256 stake;
        if (nft.balanceOf(msg.sender) > 0) {
            stake = msg.value;
        } else {
            if (msg.value <= ENTRY_FEE) revert InsufficientEntryFee();
            (bool ok,) = treasury.call{value: ENTRY_FEE}("");
            if (!ok) revert TransferFailed();
            stake = msg.value - ENTRY_FEE;
        }

        Game storage g = games[gameId];
        if (g.status != Status.OPEN) revert AlreadyResolved();
        if (stake < MIN_BET)         revert BelowMinBet();

        uint256 sideTotal = side == Side.LONG ? g.totalLongStake : g.totalShortStake;
        if (sideTotal + stake > MAX_STAKE_PER_SIDE) revert ExceedsMaxStake();

        userStake[gameId][msg.sender][side] += stake;
        if (side == Side.LONG) g.totalLongStake  += stake;
        else                   g.totalShortStake += stake;
        emit Bet(gameId, msg.sender, side, stake);
    }

    function snapshot(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.OPEN) revert AlreadyResolved();
        if (g.snapshotPrice != 0)    revert SnapshotAlreadyTaken();

        uint256 closeBlock = bettingCloseBlock(gameId);
        if (block.number < closeBlock)                      revert BettingNotClosed();
        if (block.number >= closeBlock + SNAPSHOT_WINDOW)  revert SnapshotWindowMissed();

        g.snapshotPrice = IPriceFeed(feed).ronPriceUsd1e18();
        emit Snapshot(gameId, g.snapshotPrice);
    }

    function expireMissedSnapshot(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.OPEN) revert AlreadyResolved();
        if (g.snapshotPrice != 0)    revert SnapshotAlreadyTaken();

        uint256 closeBlock = bettingCloseBlock(gameId);
        if (block.number < closeBlock + SNAPSHOT_WINDOW) revert SnapshotWindowNotClosed();

        g.status = Status.EXPIRED;
        emit Expired(gameId);
    }

    function resolve(uint256 gameId) external {
        Game storage g = games[gameId];
        if (g.status != Status.OPEN) revert AlreadyResolved();

        uint256 resBlock = resolutionBlock(gameId);
        if (block.number < resBlock) revert ResolutionBlockNotReached();

        if (block.number >= resBlock + RESOLUTION_WINDOW) {
            g.status = Status.EXPIRED;
            emit Expired(gameId);
            return;
        }
        if (g.snapshotPrice == 0) {
            g.status = Status.EXPIRED;
            emit Expired(gameId);
            return;
        }
        if (g.totalLongStake == 0 || g.totalShortStake == 0) {
            g.status = Status.REFUNDED;
            emit Refunded(gameId);
            return;
        }

        uint256 endPrice = IPriceFeed(feed).ronPriceUsd1e18();
        g.resolvedPrice  = endPrice;

        if (endPrice == g.snapshotPrice) {
            g.status = Status.REFUNDED;
            emit Refunded(gameId);
            return;
        }

        Side winner   = endPrice > g.snapshotPrice ? Side.LONG : Side.SHORT;
        g.winningSide = winner;

        uint256 losingTotal  = winner == Side.LONG ? g.totalShortStake : g.totalLongStake;
        uint256 winningTotal = winner == Side.LONG ? g.totalLongStake  : g.totalShortStake;
        uint256 fee          = losingTotal * POT_FEE_BPS / BPS_DENOM;
        g.feeCollected = fee;
        g.status       = Status.RESOLVED;

        // Snapshot accumulators before updating totals - only PoD arriving after
        // this resolution point counts for this game's participants.
        _registerBet(gameId, losingTotal, winningTotal);
        emit Resolved(gameId, winner, endPrice);

        if (fee > 0) {
            (bool ok,) = treasury.call{value: fee}("");
            if (!ok) revert TransferFailed();
        }
    }

    function claim(uint256 gameId) external {
        if (claimed[gameId][msg.sender]) revert AlreadyClaimed();

        Game storage g = games[gameId];
        uint256 payout;

        if (g.status == Status.REFUNDED || g.status == Status.EXPIRED) {
            uint256 longStake  = userStake[gameId][msg.sender][Side.LONG];
            uint256 shortStake = userStake[gameId][msg.sender][Side.SHORT];
            payout = longStake + shortStake;
            if (payout == 0) revert NothingToClaim();
        } else if (g.status == Status.RESOLVED) {
            uint256 myWinStake = userStake[gameId][msg.sender][g.winningSide];
            if (myWinStake == 0) revert NothingToClaim();

            uint256 winTotal   = g.winningSide == Side.LONG ? g.totalLongStake  : g.totalShortStake;
            uint256 loseTotal  = g.winningSide == Side.LONG ? g.totalShortStake : g.totalLongStake;
            uint256 netLosePot = loseTotal - g.feeCollected;
            payout = myWinStake + myWinStake * netLosePot / winTotal;
        } else {
            revert BettingClosed(); // still OPEN
        }

        claimed[gameId][msg.sender] = true;
        emit Claimed(gameId, msg.sender, payout);

        (bool ok,) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    // ── Game views ────────────────────────────────────────────────────────────

    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    function userLossInGame(uint256 gameId, address user) public view returns (uint256) {
        Game storage g = games[gameId];
        if (g.status != Status.RESOLVED) return 0;
        Side losingSide = g.winningSide == Side.LONG ? Side.SHORT : Side.LONG;
        return userStake[gameId][user][losingSide];
    }

    function userWinStakeInGame(uint256 gameId, address user) public view returns (uint256) {
        Game storage g = games[gameId];
        if (g.status != Status.RESOLVED) return 0;
        return userStake[gameId][user][g.winningSide];
    }

    // ── PoD inflow ────────────────────────────────────────────────────────────

    /// @notice Receives PoD RON sent directly by the Ronin protocol.
    receive() external payable {
        _distribute(msg.value);
    }

    /// @notice Sweeper forwards BetPool's share of PoD here; triggers the 80/20 split.
    function sweep() external payable {
        if (msg.value == 0) revert NothingToClaim();
        _distribute(msg.value);
    }

    /// @dev Splits an inflow 80% to losers / 20% to winners.
    ///      If no games have resolved yet (totalCumulativeLoss or totalCumulativeWin
    ///      is zero), there are no claimants for that share — it falls back to
    ///      treasury rather than sitting unclaimable in the contract.
    function _distribute(uint256 total) private {
        totalReceived += total;
        uint256 loserShare  = total * LOSER_BPS / BPS_DENOM;
        uint256 winnerShare = total - loserShare;
        uint256 toTreasury  = 0;

        if (totalCumulativeLoss > 0) {
            accLoserRewardPerUnit += loserShare * 1e18 / totalCumulativeLoss;
        } else {
            toTreasury += loserShare;
        }

        if (totalCumulativeWin > 0) {
            accWinRewardPerUnit += winnerShare * 1e18 / totalCumulativeWin;
        } else {
            toTreasury += winnerShare;
        }

        emit RewardReceived(total, loserShare, winnerShare);

        if (toTreasury > 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ── PoD accumulator ───────────────────────────────────────────────────────

    /// @dev Snapshots the current accumulators immediately after a game resolves.
    ///      Totals are added AFTER the snapshot so this game's own pot doesn't
    ///      earn rebate from itself.
    function _registerBet(uint256 betId, uint256 loserTotal, uint256 winnerTotal) private {
        betLoserSnapshot[betId]  = accLoserRewardPerUnit;
        betWinnerSnapshot[betId] = accWinRewardPerUnit;
        totalCumulativeLoss += loserTotal;
        totalCumulativeWin  += winnerTotal;
        emit BetRegistered(betId, loserTotal, winnerTotal);
    }

    // ── PoD user claims ───────────────────────────────────────────────────────

    function claimLoserRebate(uint256 betId) external {
        if (loserClaimed[betId][msg.sender]) revert AlreadyClaimed();
        loserClaimed[betId][msg.sender] = true;

        uint256 userLoss = userLossInGame(betId, msg.sender);
        if (userLoss == 0) revert NothingToClaim();

        uint256 rebate = userLoss * (accLoserRewardPerUnit - betLoserSnapshot[betId]) / 1e18;
        if (rebate == 0) revert NothingToClaim();

        emit LoserRebateClaimed(betId, msg.sender, rebate);
        (bool ok,) = msg.sender.call{value: rebate}("");
        if (!ok) revert TransferFailed();
    }

    function claimWinnerBonus(uint256 betId) external {
        if (winnerClaimed[betId][msg.sender]) revert AlreadyClaimed();
        winnerClaimed[betId][msg.sender] = true;

        uint256 userWinStake = userWinStakeInGame(betId, msg.sender);
        if (userWinStake == 0) revert NothingToClaim();

        uint256 bonus = userWinStake * (accWinRewardPerUnit - betWinnerSnapshot[betId]) / 1e18;
        if (bonus == 0) revert NothingToClaim();

        emit WinnerBonusClaimed(betId, msg.sender, bonus);
        (bool ok,) = msg.sender.call{value: bonus}("");
        if (!ok) revert TransferFailed();
    }

    // ── PoD views ─────────────────────────────────────────────────────────────

    function pendingLoserRebate(uint256 betId, address user) external view returns (uint256) {
        if (loserClaimed[betId][user]) return 0;
        uint256 userLoss = userLossInGame(betId, user);
        if (userLoss == 0) return 0;
        return userLoss * (accLoserRewardPerUnit - betLoserSnapshot[betId]) / 1e18;
    }

    function pendingWinnerBonus(uint256 betId, address user) external view returns (uint256) {
        if (winnerClaimed[betId][user]) return 0;
        uint256 userWinStake = userWinStakeInGame(betId, user);
        if (userWinStake == 0) return 0;
        return userWinStake * (accWinRewardPerUnit - betWinnerSnapshot[betId]) / 1e18;
    }

    // ── UUPS ─────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
