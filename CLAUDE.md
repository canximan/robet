# Robet - CLAUDE.md

Robet is a PvP LONG/SHORT betting game on Ronin Chain. Players bet on whether the RON/USD price will be higher or lower after a 1-hour hold. Winners take the losing pot (minus 2% fee). Losers and winners both share Ronin PoD reward inflows - turning losing into delayed yield to drive an activity flywheel (more bets → more PoD → more rebate → more bets).

---

## Contracts (Solidity 0.8.26, Foundry)

| Contract | Role |
|---|---|
| `RobetNFT` | ERC721 membership NFT. Holders bypass the per-bet entry fee. 1 000 minted at deploy (implicit range, O(1) gas). |
| `PriceFeed` | Two-hop spot price: WRON/WETH × WETH/USDC from Katana V2 pools → RON/USD scaled 1e18. |
| `MockPriceFeed` | Local/testnet only. Fixed price, owner can call `setPrice()`. Keeper bumps it ±3–8% after each snapshot so games don't always tie. |
| `BetPool` | Core game logic + PoD accumulator. Auto-cycling games, no factory. Splits incoming PoD 80 % losers / 20 % winners (MasterChef-style, no iteration). |

---

## Game Mechanics

### Timing (all in blocks, Ronin ≈ 3 s/block)

```
|←── BETTING_BLOCKS = 1 200 (1 h) ──→|←── HOLD_BLOCKS = 1 200 (1 h) ──→|
^bettingOpen(N)                        ^bettingClose(N)                   ^resolutionBlock(N)
                                       └─ SNAPSHOT_WINDOW = 10 blocks     └─ RESOLUTION_WINDOW = 30 blocks
```

Games run back-to-back with no gap.

### Game ID derivation (no storage needed)

```solidity
currentGameId()    = (block.number − GENESIS_BLOCK) / BETTING_BLOCKS
bettingOpenBlock   = GENESIS_BLOCK + N * BETTING_BLOCKS
bettingCloseBlock  = GENESIS_BLOCK + (N+1) * BETTING_BLOCKS
resolutionBlock    = bettingCloseBlock + HOLD_BLOCKS
```

### Phases (frontend derives from block number + on-chain status)

| Phase | Condition |
|---|---|
| `betting` | `block < bettingCloseBlock` |
| `snapshot-window` | `block < bettingCloseBlock + 10` |
| `snapshot-missed` | status==OPEN, snapshotPrice==0, window closed |
| `hold` | snapshot taken, `block < resolutionBlock` |
| `resolution-window` | `block < resolutionBlock + 30` |
| `settled` | status != OPEN |

### Status values

`OPEN=0, RESOLVED=1, REFUNDED=2, EXPIRED=3`

`REFUNDED` = tie (endPrice == snapshotPrice).  
`EXPIRED` = keeper missed snapshot window → `expireMissedSnapshot()` callable by anyone → immediate refund without waiting the full hold period.

### Key contract constants

```solidity
BETTING_BLOCKS    = 1_200
HOLD_BLOCKS       = 1_200
SNAPSHOT_WINDOW   = 10
RESOLUTION_WINDOW = 30
POT_FEE_BPS       = 200    // 2% of losing pot
MAX_STAKE_PER_SIDE = 5_000 ether
MIN_BET           = 1 ether
ENTRY_FEE         = 0.1 ether // non-NFT holders only, per bet
```

### Payout formula (winner)

```
payout = myWinStake + myWinStake × (losingTotal − feeCollected) / winningTotal
```

Winners claim via `BetPool.claim(gameId)`. Losers have nothing to claim from the pot — only PoD rebate via `BetPool.claimLoserRebate(gameId)`.

---

## BetPool PoD yield

MasterChef-style accumulator built directly into BetPool — no separate RewardDistributor contract.

- `accLoserRewardPerUnit` — grows with each PoD inflow: `+= 80% of inflow / totalCumulativeLoss`
- `accWinRewardPerUnit`  — grows with each PoD inflow: `+= 20% of inflow / totalCumulativeWin`
- At resolve time, BetPool snapshots both accumulators then adds the game's loss/win totals.
- User's share = `userAmount × (accNow − snapshotAtResolution) / 1e18` — only PoD arriving *after* resolution accrues to that game's participants.

**BetPool-internal PoD split:** 80 % losers / 20 % winners.

**Sweeper macro split (before forwarding to BetPool):** 30 % BetPool / 60 % Staking / 10 % Treasury.

**Anti-wash-trade:** 2 % pot fee on every game. Together with the rebate mechanism, any round-trip wash trade is net-negative.

---

## Keeper (`script/keeper.ts`)

Runs every `POLL_INTERVAL_MS` (default 15 000 ms). Uses sequential `setTimeout` loop (NOT `setInterval`) to avoid overlapping ticks.

Responsibilities per tick:
1. Compute `pendingGameIds(blockNumber)` → `{ toSnapshot, toExpire, toResolve }`
2. Filter candidates to status==OPEN via individual `readContract` calls (no multicall3 - Anvil doesn't have it)
3. Call `snapshot()`, `expireMissedSnapshot()`, or `resolve()` as needed

**Mock price bump:** On local/testnet (`MOCK_PRICE_BUMP=true`), after each snapshot the keeper calls `MockPriceFeed.setPrice()` using `MOCK_OWNER_KEY` (the deployer key) to apply a random ±3–8% price move so games don't always tie-refund.

Run modes:
```bash
cd script
npm run keeper         # daemon
npm run keeper:once    # single pass (for cron/CI)
```

---

## Sweeper (`script/sweeper.ts`)

Watches the PoD treasury EOA balance. When balance > `MIN_SWEEP_RON` (default 1 RON), splits the accumulated RON and dispatches in three sequential txs, leaving `GAS_BUFFER = 0.02 RON` for gas:

```
30 % → BetPool.sweep()      (80 % losers · 20 % winners inside BetPool)
60 % → Staking.sweep()      (pro-rata to all RON stakers)
10 % → TREASURY_ADDRESS     (cold-wallet protocol cut, plain transfer)
```

```bash
npm run sweeper        # daemon
npm run sweeper:once   # single pass
```

---

## Script env (`script/.env`)

```
CHAIN_ID=31337                  # 31337=anvil | 2021=saigon | 2020=mainnet
RONIN_RPC_URL=http://127.0.0.1:8545
BET_POOL_ADDRESS=0x...
KEEPER_PRIVATE_KEY=0x...
POLL_INTERVAL_MS=5000

# MockPriceFeed (local/testnet only)
PRICE_FEED_ADDRESS=0x...
MOCK_PRICE_BUMP=true
MOCK_OWNER_KEY=0x...            # deployer key = MockPriceFeed owner

# Sweeper
TREASURY_PRIVATE_KEY=0x...
STAKING_ADDRESS=0x...
MIN_SWEEP_RON=1
MAX_SWEEP_RON=100
```

---

## Frontend (Next.js 15, wagmi v2, viem, Tailwind)

### Env (`frontend/.env.local` / `.env.production.local`)

```
NEXT_PUBLIC_BET_POOL=0x...
NEXT_PUBLIC_PRICE_FEED=0x...
NEXT_PUBLIC_ACCESS_GATE=0x...
NEXT_PUBLIC_REWARD_DISTRIBUTOR=0x...
NEXT_PUBLIC_TREASURY_WALLET=0x...
```

### Key files

| File | Purpose |
|---|---|
| `src/lib/contracts.ts` | All ABIs, contract addresses, constants, helpers (`formatPrice`, `formatRon`, `formatCountdown`, `explorerTxUrl`) |
| `src/app/page.tsx` | 4-tab layout: Active / History / My Games / Rewards |
| `src/components/GameCard.tsx` | Per-game card with phase-aware UI, bet form, claim buttons, P&L display |
| `src/components/GameRules.tsx` | `?` button → modal explaining the full game cycle |
| `src/components/RewardsPanel.tsx` | PoD stats, pending rewards, claim history |
| `src/app/api/pod-claims/route.ts` | GET/POST API for claim history persistence |

### Claim history storage

Stored in `frontend/data/claims/<address-lowercase>.json`. One file per wallet. The API deduplicates by `txHash`. Records: `pot` (pot win claim), `rebate` (BetPool loser PoD), `bonus` (BetPool winner PoD), `stake`, `unstake`, `stake-pod` (Staking actions). Persists across page reloads; not suitable for Vercel (no persistent FS) — use a VPS or swap for SQLite.

Run in production:
```bash
cd frontend
npm run build
npm run start -- -p 3000
```

### Claim button rules

- **Claim (pot):** only shown when: game RESOLVED and `myWinStake > 0`, OR game REFUNDED/EXPIRED and `userHasAny`.
- **Claim PoD:** shown when `pendingLoserRebate > 0` or `pendingWinnerBonus > 0` (naturally zero after claiming if no new PoD has arrived).

---

## Deployment notes

- **Fresh EOA for PoD registration.** Ronin PoD admin wallet is one-way retired on transfer — never reuse keys. Use a cold deployer EOA on both testnet and mainnet.
- **Deployment order:** RobetNFT → PriceFeed → BetPool (proxy) → Staking → `nft.setMinter(staking)` → `nft.transferOwnership(coldWallet)`.
- **GENESIS_BLOCK** is set in the BetPool initializer. The first game's betting window opens at that block.
- **PoD treasury wallet** = the EOA that receives Ronin PoD payouts. The sweeper watches it and splits each tick 30 % → BetPool / 60 % → Staking / 10 % kept in treasury.

---

## Chains

| Chain | ID | Notes |
|---|---|---|
| Anvil local | 31337 | Use MockPriceFeed, MOCK_PRICE_BUMP=true |
| Saigon testnet | 2021 | Deploy with fresh EOA before mainnet |
| Ronin mainnet | 2020 | Real PriceFeed (Katana V2 two-hop spot) |

Ronin block time ≈ 3 seconds. No multicall3 on Anvil - use individual `readContract` calls.
