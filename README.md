# Robet

A PvP LONG/SHORT betting game on Ronin Chain. Players bet on whether the RON/USD price will be higher or lower after a 1-hour hold. Winners take the losing pot (minus 2% fee). Losers and winners both share [Proof of Distribution](https://docs.roninchain.com/proof-of-distribution/) rewards - turning losing into delayed yield to drive an activity flywheel.

## How it works

1. Each 1-hour window is a game. Bet LONG or SHORT on RON/USD.
2. At close, the keeper snapshots the entry price from Katana V2 pools.
3. After another hour, the keeper resolves using the end price.
4. Winners split the losing pot (minus 2% fee to treasury).
5. PoD rewards are split by the sweeper: **30% to BetPool** (80% losers · 20% winners) · **60% to Staking** (pro-rata to RON stakers) · **10% to treasury**.

## Membership

Hold a **Robet NFT** to bet without any extra cost. Non-holders pay a **0.1 RON entry fee** per bet (sent to the fee wallet, not the pot).

## Contracts

| Contract | Role |
|---|---|
| `RobetNFT` | ERC721 membership NFT. Holders skip the per-bet entry fee. 1 000 pre-minted at deploy. |
| `PriceFeed` | Two-hop spot price: WRON/WETH × WETH/USDC from Katana V2 pools → RON/USD (1e18). |
| `MockPriceFeed` | Local/testnet only. Fixed price; keeper bumps ±3–8% after each snapshot. |
| `BetPool` | Core game logic + PoD accumulator. Auto-cycling games, pull-based claims, permissionless resolve. Splits incoming PoD 80 % losers / 20 % winners. |
| `Staking` | RON staking with pro-rata PoD sharing and probabilistic NFT minting (halving schedule, 33 k cap). |

## Key parameters

| Parameter | Value |
|---|---|
| Betting window | 1 200 blocks (~1 h) |
| Hold window | 1 200 blocks (~1 h) |
| Pot fee | 2% of losing pot |
| Entry fee (no NFT) | 0.1 RON per bet |
| Min bet | 1 RON |
| Max stake per side | 5 000 RON |
| PoD rebate cap | 50% of loss (anti-wash) |

## Running locally

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash && foundryup

# Build contracts
forge build

# Start local chain
anvil

# Deploy (in a new terminal)
cp .env.example .env   # fill in DEPLOYER_PRIVATE_KEY etc.
cd script && npm install && npm run deploy

# Run keeper
npm run keeper

# Run frontend
cd frontend && npm install && npm run dev
```

## Deployment

```bash
# Saigon testnet
cd script && npm run deploy -- --chain saigon

# Ronin mainnet
cd script && npm run deploy -- --chain mainnet
```

The deploy script runs `forge script`, reads the broadcast artifacts, and auto-patches the root `.env` with all contract addresses (both backend and `NEXT_PUBLIC_*` frontend mirrors).

**Deployment order:** RobetNFT → PriceFeed → BetPool (proxy) → Staking → `nft.setMinter(staking)` → `nft.transferOwnership(coldWallet)`

## Reference addresses (Ronin mainnet)

- WRON: `0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4`
- WRON/WETH pool (Katana V2): `0x2ECb08F87F075b5769Fe543d0e52e40140575ea7`
- WETH/USDC pool (Katana V2): `0xA7964991f339668107E2b6A6f6b8e8B74Aa9D017`

## Chains

| Chain | ID | Notes |
|---|---|---|
| Anvil local | 31337 | MockPriceFeed, `MOCK_PRICE_BUMP=true` |
| Saigon testnet | 2021 | Use fresh deployer EOA |
| Ronin mainnet | 2020 | Real PriceFeed |

> ⚠️ **PoD admin wallet is one-way retired on transfer.** Use a fresh cold EOA for each deployment environment and never reuse it.
