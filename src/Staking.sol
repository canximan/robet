// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRobetNFT {
    function mint(address to) external returns (uint256);
    function MAX_SUPPLY()     external view returns (uint256);
    function totalSupply()    external view returns (uint256);
}

/// @title Staking
/// @notice Stake >= 1 000 RON to participate in PoD rewards and roll for NFTs.
///
/// PoD rewards
/// ───────────
///   All RON sent via sweep() / receive() is shared among current stakers in
///   proportion to their stake using a MasterChef-style accumulator. Anyone
///   meeting MIN_STAKE earns a share - no per-stake threshold for PoD.
///
/// NFT lottery
/// ───────────
///   Every 1 day, callers can attempt claimAndRestake(). Stake size determines
///   the number of dice rolls in one call (1 roll per 10 000 RON); per-roll win
///   probability halves each year. A cumulative cap (expectedMintsBy) enforces
///   an emission schedule: 16 500 NFTs in year 0, halving each
///   subsequent year, asymptotic to MAX_SUPPLY (33 000) over ~33 years.
///
/// Unstaking is allowed any time; full unstake resets the 3-day lock.
contract Staking is ReentrancyGuard {

    IRobetNFT public immutable nft;
    uint256   public immutable deployTime;

    // ── Deploy-time tunables (configurable for local testing) ─────────────────
    /// @notice Minimum RON for a first-time stake; PoD rewards require this floor.
    uint256 public immutable MIN_STAKE;
    /// @notice RON per dice roll. 10 000 in prod (1 NFT chance per 10k RON staked);
    ///         set lower for local testing.
    uint256 public immutable NFT_THRESHOLD;
    /// @notice Cooldown before a stake can roll the dice. 1 day in prod; can be
    ///         shortened to seconds for local testing via the deploy script.
    uint256 public immutable LOCK_PERIOD;
    /// @notice Length of one halving period. 365 days in prod; shorten for tests
    ///         so the schedule accumulates roll budget faster (e.g. 1 hour).
    uint256 public immutable YEAR_SECONDS;
    /// @notice Per-roll win probability in basis points at year 0; halves yearly.
    ///         500 bps (5 %) in prod, calibrated for daily claims; bump for tests.
    uint256 public immutable BASE_PROB_BPS;

    // ── Fixed tunables (baked into bytecode) ──────────────────────────────────
    uint256 public constant MAX_SUPPLY          = 33_000;
    uint256 public constant FIRST_YEAR_TARGET   = 16_500;       // = MAX_SUPPLY / 2
    uint256 public constant ROLLS_PER_CLAIM_CAP = 100;          // gas safety

    // ── State ─────────────────────────────────────────────────────────────────
    uint256 public totalStaked;
    uint256 public accRewardPerShare;  // ×1e18, MasterChef accumulator
    uint256 public nftsMinted;
    uint256 public claimNonce;         // disambiguates the seed when two claims share a block

    // NOTE on bootstrapping: this contract intentionally has no pre-staker escrow.
    // PoD that arrives while totalStaked == 0 is silently dropped (stays in the
    // contract balance with no accounting hook). The deployer MUST make a small
    // bootstrap stake immediately after deploy so the very first sweep already
    // has a recipient. Without that, the first sweep's RON is unrecoverable.

    struct StakeInfo {
        uint256 amount;
        uint256 stakedAt;     // 0 when fully unstaked
        uint256 rewardDebt;
    }
    mapping(address => StakeInfo) public stakes;

    // ── Events ────────────────────────────────────────────────────────────────
    event Staked            (address indexed user, uint256 added,   uint256 total);
    event Unstaked          (address indexed user, uint256 removed, uint256 remaining);
    event RewardClaimed     (address indexed user, uint256 amount);
    event ClaimResult       (address indexed user, uint256 rolls,   uint256 minted);
    event RewardsDistributed(uint256 amount);

    constructor(
        address _nft,
        uint256 _minStake,       // wei, e.g. 1000 ether for prod, 100 ether for local
        uint256 _nftThreshold,   // wei, e.g. 10_000 ether for prod, 200 ether for local
        uint256 _lockPeriod,     // seconds, e.g. 1 days for prod, 300 for local
        uint256 _yearSeconds,    // seconds, e.g. 365 days for prod, 3600 for local
        uint256 _baseProbBps     // bps, e.g. 500 (5%) for prod, 1500 (15%) for local
    ) {
        require(_minStake > 0,         "min stake = 0");
        require(_nftThreshold > 0,     "threshold = 0");
        require(_lockPeriod > 0,       "lock = 0");
        require(_yearSeconds > 0,      "year = 0");
        require(_baseProbBps > 0 && _baseProbBps <= 10_000, "bad prob");
        nft           = IRobetNFT(_nft);
        deployTime    = block.timestamp;
        MIN_STAKE     = _minStake;
        NFT_THRESHOLD = _nftThreshold;
        LOCK_PERIOD   = _lockPeriod;
        YEAR_SECONDS  = _yearSeconds;
        BASE_PROB_BPS = _baseProbBps;
    }

    // ── Stake / unstake ───────────────────────────────────────────────────────

    function stake() external payable nonReentrant {
        require(msg.value > 0, "zero");
        StakeInfo storage s = stakes[msg.sender];

        // First-time stake must meet MIN_STAKE; subsequent top-ups have no minimum.
        if (s.amount == 0) require(msg.value >= MIN_STAKE, "below MIN_STAKE");

        _harvest(msg.sender);

        bool fresh = s.amount == 0;
        totalStaked += msg.value;
        s.amount    += msg.value;
        s.rewardDebt = s.amount * accRewardPerShare / 1e18;
        if (fresh) s.stakedAt = block.timestamp;

        emit Staked(msg.sender, msg.value, s.amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        require(amount > 0 && amount <= s.amount, "bad amount");

        _harvest(msg.sender);

        totalStaked -= amount;
        s.amount    -= amount;
        s.rewardDebt = s.amount * accRewardPerShare / 1e18;
        if (s.amount == 0) s.stakedAt = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");

        emit Unstaked(msg.sender, amount, s.amount);
    }

    // ── Issuance schedule ─────────────────────────────

    /// @notice Cumulative NFTs that *should* have been minted by `t` according
    ///         to the halving schedule. Used as a hard ceiling in claim().
    ///
    /// @dev Integer division of the per-year allocation by YEAR_SECONDS rounds
    ///      to 0 for the first ~30 minutes (year-0 scale), which would block
    ///      every claim immediately after deployment. We floor the partial-year
    ///      portion to 1 once any time has elapsed so the first NFT is always
    ///      mintable. The cap then catches up to the real schedule as time
    ///      passes (e.g. ~2 NFTs at t ≈ 64 min on year-0 scale).
    function expectedMintsBy(uint256 t) public view returns (uint256) {
        if (t <= deployTime) return 0;
        uint256 elapsed = t - deployTime;
        uint256 yearIdx = elapsed / YEAR_SECONDS;
        if (yearIdx >= 33) return MAX_SUPPLY;

        // Cumulative at start of year yearIdx: MAX_SUPPLY * (1 - 1/2^yearIdx).
        uint256 startOfYear     = MAX_SUPPLY - (MAX_SUPPLY >> yearIdx);
        uint256 thisYearAlloc   = FIRST_YEAR_TARGET >> yearIdx; // 16500 / 2^yearIdx
        uint256 yearFracPart    = elapsed % YEAR_SECONDS;
        uint256 partialThisYear = thisYearAlloc * yearFracPart / YEAR_SECONDS;
        // Floor: unlock at least 1 NFT once any time has passed, so the lottery
        // isn't dead-zoned by integer truncation during the first half-hour.
        if (partialThisYear == 0 && thisYearAlloc > 0) partialThisYear = 1;
        return startOfYear + partialThisYear;
    }

    /// @notice Per-roll win probability in basis points (bps; 10000 = 100 %).
    ///         Halves each year via right-shift; returns 0 once exhausted.
    function currentProbBps() public view returns (uint256) {
        uint256 yearIdx = (block.timestamp - deployTime) / YEAR_SECONDS;
        // Guard against shift-overflow; well before that the value is already 0.
        if (yearIdx >= 256) return 0;
        return BASE_PROB_BPS >> yearIdx;
    }

    /// @notice Earliest timestamp at which the caller's 3-day lock completes.
    function unlockAt(address user) external view returns (uint256) {
        StakeInfo storage s = stakes[user];
        if (s.stakedAt == 0) return type(uint256).max;
        return s.stakedAt + LOCK_PERIOD;
    }

    // ── NFT lottery ───────────────────────────────────────────────────────────

    /// @notice Roll the dice. Lock restarts regardless of outcome.
    ///         Emits ClaimResult(rolls, minted). minted may be 0.
    function claimAndRestake() external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        require(s.amount >= MIN_STAKE,                       "below MIN_STAKE");
        require(s.stakedAt > 0,                              "not staked");
        require(block.timestamp >= s.stakedAt + LOCK_PERIOD, "lock period not over");

        // Reset the 3-day timer immediately so the user can't replay the call.
        s.stakedAt = block.timestamp;

        // Global supply / schedule ceiling.
        uint256 cap = expectedMintsBy(block.timestamp);
        if (nftsMinted >= MAX_SUPPLY || nftsMinted >= cap) {
            emit ClaimResult(msg.sender, 0, 0);
            return;
        }

        // Number of dice rolls = stake / 10 000 RON, gas-capped.
        uint256 rolls = s.amount / NFT_THRESHOLD;
        if (rolls == 0) {
            // Sub-threshold stake earns PoD only - no NFT chance.
            emit ClaimResult(msg.sender, 0, 0);
            return;
        }
        if (rolls > ROLLS_PER_CLAIM_CAP) rolls = ROLLS_PER_CLAIM_CAP;

        uint256 prob = currentProbBps();
        if (prob == 0) {
            emit ClaimResult(msg.sender, rolls, 0);
            return;
        }

        // Pseudo-random seed. Sufficient for a JPEG lottery; not VRF-grade.
        // claimNonce ensures two claims in the same block get different rolls.
        bytes32 seed = keccak256(abi.encodePacked(
            blockhash(block.number - 1),
            msg.sender,
            ++claimNonce
        ));

        uint256 minted;
        for (uint256 i; i < rolls;) {
            if (nftsMinted >= cap || nftsMinted >= MAX_SUPPLY) break;
            uint256 r = uint256(keccak256(abi.encodePacked(seed, i))) % 10_000;
            if (r < prob) {
                unchecked { ++nftsMinted; ++minted; }
                nft.mint(msg.sender);
            }
            unchecked { ++i; }
        }
        emit ClaimResult(msg.sender, rolls, minted);
    }

    // ── PoD rewards (MasterChef accumulator) ──────────────────────────────────

    function pendingReward(address user) public view returns (uint256) {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0) return 0;
        return s.amount * accRewardPerShare / 1e18 - s.rewardDebt;
    }

    function claimReward() external nonReentrant { _harvest(msg.sender); }

    /// @notice Called by the sweeper to distribute incoming RON.
    function sweep() external payable { _distribute(msg.value); }

    /// @notice Plain RON transfers are also distributed.
    receive() external payable        { _distribute(msg.value); }

    function _distribute(uint256 amount) internal {
        // Drops the RON on the floor if there are no stakers — the deployer's
        // bootstrap stake (see the note next to `claimNonce`) is what prevents
        // this from happening in practice.
        if (amount == 0 || totalStaked == 0) return;
        accRewardPerShare += amount * 1e18 / totalStaked;
        emit RewardsDistributed(amount);
    }

    function _harvest(address user) internal {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0) return;
        uint256 pending = s.amount * accRewardPerShare / 1e18 - s.rewardDebt;
        s.rewardDebt    = s.amount * accRewardPerShare / 1e18;
        if (pending == 0) return;
        (bool ok,) = user.call{value: pending}("");
        require(ok, "reward transfer failed");
        emit RewardClaimed(user, pending);
    }
}
