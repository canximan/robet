// Contract addresses - replace after deployment.
// Use NEXT_PUBLIC_ env vars so they can differ per environment.
const ZERO = '0x0000000000000000000000000000000000000000' as const

export const ADDRESSES = {
  robetNft:          (process.env.NEXT_PUBLIC_ROBET_NFT       ?? ZERO) as `0x${string}`,
  priceFeed:         (process.env.NEXT_PUBLIC_PRICE_FEED      ?? ZERO) as `0x${string}`,
  betPool:           (process.env.NEXT_PUBLIC_BET_POOL        ?? ZERO) as `0x${string}`,
  staking:           (process.env.NEXT_PUBLIC_STAKING         ?? ZERO) as `0x${string}`,
  // PoD reward distribution is handled inline by BetPool (no separate contract).
  get rewardDistributor(): `0x${string}` { return this.betPool },
  treasury:          (process.env.NEXT_PUBLIC_TREASURY_WALLET ?? ZERO) as `0x${string}`,
}

// ── ABIs (minimal - only functions the UI calls) ─────────────────────────────

export const ROBET_NFT_ABI = [
  { name: 'balanceOf',   type: 'function', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_SUPPLY',  type: 'function', stateMutability: 'view', inputs: [],                                  outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [],                                  outputs: [{ type: 'uint256' }] },
  { name: 'minter',      type: 'function', stateMutability: 'view', inputs: [],                                  outputs: [{ type: 'address' }] },
] as const

export const STAKING_ABI = [
  // Reads
  { name: 'stakes', type: 'function', stateMutability: 'view',
    inputs:  [{ name: 'addr', type: 'address' }],
    outputs: [
      { name: 'amount',     type: 'uint256' },
      { name: 'stakedAt',   type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
    ]},
  { name: 'pendingReward',    type: 'function', stateMutability: 'view',
    inputs: [{ name: 'u', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'unlockAt',         type: 'function', stateMutability: 'view',
    inputs: [{ name: 'u', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'expectedMintsBy',  type: 'function', stateMutability: 'view',
    inputs: [{ name: 't', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'currentProbBps',   type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalStaked',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nftsMinted',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'deployTime',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MIN_STAKE',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'NFT_THRESHOLD',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'LOCK_PERIOD',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_SUPPLY',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // Writes
  { name: 'stake',            type: 'function', stateMutability: 'payable',    inputs: [], outputs: [] },
  { name: 'unstake',          type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'claimAndRestake',  type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'claimReward',      type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  // Events (for parsing claim outcomes)
  { name: 'ClaimResult', type: 'event', inputs: [
    { name: 'user',   type: 'address', indexed: true },
    { name: 'rolls',  type: 'uint256' },
    { name: 'minted', type: 'uint256' },
  ]},
] as const

export const BET_POOL_ABI = [
  // ── Write ──────────────────────────────────────────────────────────────────
  {
    name: 'bet', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'gameId', type: 'uint256' }, { name: 'side', type: 'uint8' }],
    outputs: [],
  },
  {
    name: 'snapshot', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'expireMissedSnapshot', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'resolve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claim', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [],
  },
  // ── Timing views ───────────────────────────────────────────────────────────
  {
    name: 'currentGameId', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'bettingOpenBlock', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'bettingCloseBlock', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'resolutionBlock', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  // ── Game state ─────────────────────────────────────────────────────────────
  {
    name: 'getGame', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'snapshotPrice',   type: 'uint256' },
        { name: 'resolvedPrice',   type: 'uint256' },
        { name: 'totalLongStake',  type: 'uint256' },
        { name: 'totalShortStake', type: 'uint256' },
        { name: 'feeCollected',    type: 'uint256' },
        { name: 'status',          type: 'uint8'   },
        { name: 'winningSide',     type: 'uint8'   },
      ],
    }],
  },
  {
    name: 'userStake', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'gameId', type: 'uint256' },
      { name: 'user',   type: 'address' },
      { name: 'side',   type: 'uint8'   },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'claimed', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'gameId', type: 'uint256' }, { name: 'user', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // ── Constants & immutables ─────────────────────────────────────────────────
  { name: 'GENESIS_BLOCK',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'BETTING_BLOCKS',     type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'HOLD_BLOCKS',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'SNAPSHOT_WINDOW',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'RESOLUTION_WINDOW',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'MAX_STAKE_PER_SIDE', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'ENTRY_FEE',          type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export const PRICE_FEED_ABI = [
  {
    name: 'ronPriceUsd1e18', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
] as const

export const REWARD_DISTRIBUTOR_ABI = [
  {
    name: 'claimLoserRebate', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'betId', type: 'uint256' }], outputs: [],
  },
  {
    name: 'claimWinnerBonus', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'betId', type: 'uint256' }], outputs: [],
  },
  {
    name: 'pendingLoserRebate', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'betId', type: 'uint256' }, { name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'pendingWinnerBonus', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'betId', type: 'uint256' }, { name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalReceived', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalCumulativeLoss', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalCumulativeWin', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'accLoserRewardPerUnit', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'accWinRewardPerUnit', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
  {
    name: 'loserClaimed', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'betId', type: 'uint256' }, { name: 'user', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'winnerClaimed', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'betId', type: 'uint256' }, { name: 'user', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const

// ── Constants ─────────────────────────────────────────────────────────────────

export const SIDE   = { LONG: 0, SHORT: 1 } as const
export const STATUS = { OPEN: 0, RESOLVED: 1, REFUNDED: 2, EXPIRED: 3 } as const

// These mirror the Solidity constants and are hardcoded to avoid extra RPC calls.
// Update if the contract is redeployed with different values.
export const BETTING_BLOCKS      = 1_200n // 1 h @ 3 s/block
export const HOLD_BLOCKS         = 1_200n
export const SNAPSHOT_WINDOW     = 10n
export const RESOLUTION_WINDOW   = 30n
export const ENTRY_FEE           = 10n ** 17n // 0.1 RON for non-NFT holders

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a 1e18-scaled USD price to a human-readable string like "$3.20". */
export function formatPrice(p: bigint): string {
  const dollars = Number(p) / 1e18
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** Format wei to RON string like "12.50 RON". */
export function formatRon(wei: bigint, decimals = 2): string {
  const ron = Number(wei) / 1e18
  return ron.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + ' RON'
}

/** Format a block delta as a human-readable countdown like "47m 12s". */
export function formatCountdown(blocksLeft: bigint): string {
  const secs = Number(blocksLeft) * 3
  if (secs <= 0) return 'now'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Estimate seconds until a future block (Ronin ~3s blocks). */
export function blocksToSeconds(blocks: bigint): number {
  return Number(blocks) * 3
}

const EXPLORERS: Record<number, string> = {
  2020:  'https://explorer.roninchain.com',
  2021:  'https://saigon-app.roninchain.com',
  31337: 'http://localhost',
}

/** Returns a block-explorer URL for an address on the given chain. */
export function explorerAddressUrl(address: string, chainId: number): string {
  const base = EXPLORERS[chainId] ?? EXPLORERS[2020]
  return `${base}/address/${address}`
}

/** Returns a block-explorer URL for a tx hash on the given chain. */
export function explorerTxUrl(hash: string, chainId: number): string {
  const base = EXPLORERS[chainId] ?? EXPLORERS[2020]
  return `${base}/tx/${hash}`
}

/** Returns a block-explorer URL for a block number, or null for local chains with no explorer. */
export function explorerBlockUrl(block: bigint, chainId: number): string | null {
  if (chainId === 31337) return null
  const base = EXPLORERS[chainId] ?? EXPLORERS[2020]
  return `${base}/block/${block.toString()}`
}
