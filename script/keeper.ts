/**
 * Robet keeper - snapshots and resolves auto-cycling Long/Short games.
 *
 * On each tick:
 *   1. Reads GENESIS_BLOCK and timing constants from BetPool.
 *   2. Identifies games whose snapshot window is open and calls snapshot().
 *   3. Identifies games whose resolution window is open and calls resolve().
 *
 * Two modes:
 *   --once    single pass then exit (used by GitHub Actions cron)
 *   (default) daemon loop, polling every POLL_INTERVAL_MS (default 15 000)
 *
 * Required env vars:
 *   KEEPER_PRIVATE_KEY   hex private key of the keeper wallet
 *   RONIN_RPC_URL        Ronin RPC endpoint
 *   BET_POOL_ADDRESS     deployed BetPool contract address
 */

import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'
import fs from 'fs'
import path from 'path'

const ronin = defineChain({
  id: Number(process.env.CHAIN_ID ?? 2020),
  name: 'Ronin',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RONIN_RPC_URL ?? 'https://api.roninchain.com/rpc'] } },
})

const MOCK_FEED_ABI = parseAbi([
  'function ronPriceUsd1e18() view returns (uint256)',
  'function setPrice(uint256 _price)',
])

const BET_POOL_ABI = parseAbi([
  'function GENESIS_BLOCK() view returns (uint256)',
  'function BETTING_BLOCKS() view returns (uint256)',
  'function HOLD_BLOCKS() view returns (uint256)',
  'function SNAPSHOT_WINDOW() view returns (uint256)',
  'function RESOLUTION_WINDOW() view returns (uint256)',
  'function getGame(uint256) view returns (uint256 snapshotPrice, uint256 resolvedPrice, uint256 totalLongStake, uint256 totalShortStake, uint256 feeCollected, uint8 status, uint8 winningSide)',
  'function snapshot(uint256 gameId)',
  'function resolve(uint256 gameId)',
  'function expireMissedSnapshot(uint256 gameId)',
])

const STATUS_OPEN = 0

const betPool      = process.env.BET_POOL_ADDRESS as Hex
const account      = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as Hex)
const onceMode     = process.argv.includes('--once')
const interval     = Number(process.env.POLL_INTERVAL_MS ?? 15_000)
const mockFeed      = (process.env.PRICE_FEED_ADDRESS ?? '') as Hex
// Mock price bumping: after each snapshot on local/testnet, call MockPriceFeed.setPrice()
// so resolve() sees a different price and the game doesn't always tie-refund.
// MOCK_OWNER_KEY must be the MockPriceFeed owner (= deployer key).
const mockPriceBump = process.env.MOCK_PRICE_BUMP === 'true' && !!process.env.PRICE_FEED_ADDRESS && !!process.env.MOCK_OWNER_KEY
const mockOwner     = mockPriceBump ? privateKeyToAccount(process.env.MOCK_OWNER_KEY as Hex) : null

const publicClient = createPublicClient({ chain: ronin, transport: http() })
const walletClient = createWalletClient({ chain: ronin, transport: http(), account })

// Read constants once at startup (they never change).
let genesisBlock    = 0n
let bettingBlocks   = 0n
let holdBlocks      = 0n
let snapshotWindow  = 0n
let resolutionWindow = 0n

async function loadConstants() {
  const [gb, bb, hb, sw, rw] = await Promise.all([
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'GENESIS_BLOCK' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'BETTING_BLOCKS' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'HOLD_BLOCKS' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'SNAPSHOT_WINDOW' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'RESOLUTION_WINDOW' }),
  ])
  genesisBlock     = gb
  bettingBlocks    = bb
  holdBlocks       = hb
  snapshotWindow   = sw
  resolutionWindow = rw
  console.log(`Constants loaded: GENESIS_BLOCK=${gb} BETTING=${bb} HOLD=${hb} SNAP_WIN=${sw} RES_WIN=${rw}`)
}

// Which game IDs need attention at `blockNumber`?
function pendingGameIds(blockNumber: bigint): { toSnapshot: bigint[]; toExpire: bigint[]; toResolve: bigint[] } {
  if (blockNumber < genesisBlock) return { toSnapshot: [], toExpire: [], toResolve: [] }

  const offset = blockNumber - genesisBlock

  const toSnapshot: bigint[] = []
  const toExpire:   bigint[] = []
  const toResolve:  bigint[] = []

  // Snapshot window: bettingCloseBlock(N) <= block < bettingCloseBlock(N) + SNAPSHOT_WINDOW
  const snapRemainder = offset % bettingBlocks
  if (snapRemainder < snapshotWindow) {
    const n1 = offset / bettingBlocks
    if (n1 > 0n) toSnapshot.push(n1 - 1n)
  }

  // Missed-snapshot expiry: snapshot window closed but game is still in hold period.
  // Check the game whose betting just closed (currentGameId - 1).
  // We flag it whenever offset % bettingBlocks >= snapshotWindow (window is past).
  // The contract will revert harmlessly if the game was already snapshot-ed or resolved.
  const currentGameId = offset / bettingBlocks
  if (currentGameId > 0n && snapRemainder >= snapshotWindow) {
    toExpire.push(currentGameId - 1n)
  }

  // Resolution window: resolutionBlock(N) <= block < resolutionBlock(N) + RESOLUTION_WINDOW
  if (offset >= holdBlocks) {
    const resOffset    = offset - holdBlocks
    const resRemainder = resOffset % bettingBlocks
    if (resRemainder < resolutionWindow) {
      const n1 = resOffset / bettingBlocks
      if (n1 > 0n) toResolve.push(n1 - 1n)
    }
  }

  return { toSnapshot, toExpire, toResolve }
}

const TXS_DIR = path.join(__dirname, '..', 'frontend', 'data', 'txs')

function saveTx(gameId: bigint, field: 'snapshotTx' | 'resolveTx', hash: string) {
  try {
    fs.mkdirSync(TXS_DIR, { recursive: true })
    const file = path.join(TXS_DIR, `game-${gameId}.json`)
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
    existing[field] = hash
    fs.writeFileSync(file, JSON.stringify(existing, null, 2))
  } catch (err: any) {
    console.log(`  [keeper] failed to save tx: ${err.message}`)
  }
}

// Returns the tx hash on success, null on revert/skip.
async function tryCall(label: string, fn: string, gameId: bigint): Promise<string | null> {
  try {
    const hash = await walletClient.writeContract({
      address: betPool,
      abi: BET_POOL_ABI,
      functionName: fn as any,
      args: [gameId],
    })
    console.log(`  ${label} game #${gameId} → tx ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ✓ done`)
    return hash
  } catch (err: any) {
    // Common harmless reverts: already taken/resolved, window passed, no stakes.
    console.log(`  ${label} game #${gameId} skipped: ${err.shortMessage ?? err.message}`)
    return null
  }
}

async function tick() {
  const blockNumber = await publicClient.getBlockNumber()
  const { toSnapshot, toExpire, toResolve } = pendingGameIds(blockNumber)

  if (toSnapshot.length === 0 && toExpire.length === 0 && toResolve.length === 0) {
    console.log(`[${ts()}] Block ${blockNumber} - nothing to do.`)
    return
  }

  console.log(`[${ts()}] Block ${blockNumber}`)

  // Filter to games that are actually OPEN before sending txs to avoid wasted gas.
  // Individual readContract calls - no multicall3 dependency.
  const candidates = [...new Set([...toSnapshot, ...toExpire, ...toResolve])]
  const gameResults = await Promise.all(
    candidates.map(id =>
      publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'getGame', args: [id] })
        .then(result => ({ ok: true as const, result }))
        .catch(() => ({ ok: false as const, result: null }))
    )
  )

  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i]
    const r  = gameResults[i]
    if (!r.ok) continue

    const game   = r.result!
    const status = game[5]  // uint8 status
    if (status !== STATUS_OPEN) continue

    if (toSnapshot.includes(id)) {
      const snapshotPrice = game[0]
      if (snapshotPrice === 0n) {
        const hash = await tryCall('snapshot', 'snapshot', id)
        if (hash) saveTx(id, 'snapshotTx', hash)
        // On local/testnet: randomise the mock price after snapshotting so the
        // end price differs from the entry price and the game can actually resolve.
        if (mockPriceBump) await bumpMockPrice()
      }
    }

    // If snapshot window closed with no snapshot, expire immediately so stakers
    // can refund without waiting for the full hold period.
    if (toExpire.includes(id)) {
      const snapshotPrice = game[0]
      if (snapshotPrice === 0n) {
        await tryCall('expireMissedSnapshot', 'expireMissedSnapshot', id)
      }
    }

    if (toResolve.includes(id)) {
      const hash = await tryCall('resolve', 'resolve', id)
      if (hash) saveTx(id, 'resolveTx', hash)
    }
  }
}

// Apply a random ±3–8% price move to MockPriceFeed so resolve() sees a different
// price than the snapshot and the game doesn't tie-refund every time.
// Uses MOCK_OWNER_KEY because MockPriceFeed.setPrice() is owner-only.
async function bumpMockPrice() {
  if (!mockOwner) return
  try {
    const ownerClient = createWalletClient({ chain: ronin, transport: http(), account: mockOwner })
    const current = await publicClient.readContract({ address: mockFeed, abi: MOCK_FEED_ABI, functionName: 'ronPriceUsd1e18' })
    const pct  = BigInt(3 + Math.floor(Math.random() * 6))   // 3–8 %
    const up   = Math.random() < 0.5
    const next = up ? current + current * pct / 100n : current - current * pct / 100n
    const hash = await ownerClient.writeContract({ address: mockFeed, abi: MOCK_FEED_ABI, functionName: 'setPrice', args: [next] })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  [mock] price ${up ? '↑' : '↓'} ${pct}% → $${(Number(next) / 1e18).toFixed(3)}`)
  } catch (err: any) {
    console.log(`  [mock] price bump skipped: ${err.shortMessage ?? err.message}`)
  }
}

function ts() {
  return new Date().toISOString()
}

async function main() {
  await loadConstants()
  if (onceMode) {
    await tick().catch(err => { console.error(err); process.exit(1) })
  } else {
    console.log(`Keeper daemon started. Pool: ${betPool} | Polling every ${interval / 1000}s`)
    const runLoop = async (): Promise<void> => {
      await tick()
      setTimeout(runLoop, interval)
    }
    await runLoop()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
