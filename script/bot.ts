/**
 * Robet bot - seeds initial activity by placing random bets on active games.
 *
 * On each tick the bot:
 *   1. Reads the current game from BetPool.
 *   2. Skips if the betting window is closed or the game was already bet on
 *      during this process run.
 *   3. Randomly picks sides (Long / Short / both) and a random RON amount in
 *      [BOT_MIN_RON, BOT_MAX_RON], then calls bet().
 *
 * Two modes:
 *   --once    single pass then exit (for cron / CI)
 *   (default) daemon loop, betting once per new game
 *
 * Required env vars:
 *   BOT_PRIVATE_KEY    hex private key of the bot wallet (must hold RON)
 *   RONIN_RPC_URL      Ronin RPC endpoint
 *   BET_POOL_ADDRESS   deployed BetPool proxy address
 *
 * Optional:
 *   ROBET_NFT_ADDRESS  if set, checks whether the bot wallet holds an NFT
 *                      (NFT holders skip the 0.1 RON per-bet entry fee)
 *   BOT_MIN_RON        minimum stake per side in RON  (default: 1)
 *   BOT_MAX_RON        maximum stake per side in RON  (default: 5)
 *   BOT_SIDE           which side(s) to bet each game:
 *                        'long'   - always Long
 *                        'short'  - always Short
 *                        'both'   - always both sides
 *                        'random' - 25% Long / 25% Short / 50% both (default)
 *   POLL_INTERVAL_MS   how often to check for a new game in ms (default: 60000)
 */

import {
  createPublicClient, createWalletClient,
  http, parseAbi, parseEther, formatEther,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'

// ── Chain ─────────────────────────────────────────────────────────────────────

const ronin = defineChain({
  id: Number(process.env.CHAIN_ID ?? 2020),
  name: 'Ronin',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RONIN_RPC_URL ?? 'https://api.roninchain.com/rpc'] } },
})

// ── ABIs ──────────────────────────────────────────────────────────────────────

const BET_POOL_ABI = parseAbi([
  'function currentGameId() view returns (uint256)',
  'function GENESIS_BLOCK() view returns (uint256)',
  'function BETTING_BLOCKS() view returns (uint256)',
  'function ENTRY_FEE() view returns (uint256)',
  'function MIN_BET() view returns (uint256)',
  // Returns a positional tuple - access by index (see getGame usage below).
  'function getGame(uint256) view returns (uint256, uint256, uint256, uint256, uint256, uint8, uint8)',
  'function bet(uint256 gameId, uint8 side) payable',
])

const NFT_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])

// ── Constants ─────────────────────────────────────────────────────────────────

const SIDE_LONG   = 0
const SIDE_SHORT  = 1
const STATUS_OPEN = 0

// ── Config ────────────────────────────────────────────────────────────────────

const betPool    = process.env.BET_POOL_ADDRESS  as Hex
const nftAddress = (process.env.ROBET_NFT_ADDRESS ?? '') as Hex
const minRon     = parseEther(process.env.BOT_MIN_RON ?? '1')
const maxRon     = parseEther(process.env.BOT_MAX_RON ?? '5')
const sideMode   = (process.env.BOT_SIDE ?? 'random') as 'long' | 'short' | 'both' | 'random'
const onceMode   = process.argv.includes('--once')
const interval   = Number(process.env.POLL_INTERVAL_MS ?? 60_000)

// GAS_BUFFER: RON kept in the wallet to ensure gas can always be covered.
const GAS_BUFFER = parseEther('0.05')

const account      = privateKeyToAccount(process.env.BOT_PRIVATE_KEY as Hex)
const publicClient = createPublicClient({ chain: ronin, transport: http() })
const walletClient = createWalletClient({ chain: ronin, transport: http(), account })

// Game IDs already bet on in this process run - resets on restart.
const betOn = new Set<bigint>()

// Cached on-chain constants (loaded once at startup, stable for the run).
let genesisBlock  = 0n
let bettingBlocks = 0n
let entryFee      = parseEther('0.1')
let minBet        = parseEther('0.01')
let holdsNft      = false

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString() }

/** Uniform random bigint in [lo, hi]. */
function randBigInt(lo: bigint, hi: bigint): bigint {
  if (hi <= lo) return lo
  // Safe for ranges up to ~2^53 (more than enough for RON amounts).
  return lo + BigInt(Math.floor(Math.random() * (Number(hi - lo) + 1)))
}

/** Decide which sides to bet this round based on BOT_SIDE. */
function chooseSides(): number[] {
  if (sideMode === 'long')  return [SIDE_LONG]
  if (sideMode === 'short') return [SIDE_SHORT]
  if (sideMode === 'both')  return [SIDE_LONG, SIDE_SHORT]
  // 'random': 25 % Long, 25 % Short, 50 % both
  const r = Math.random()
  if (r < 0.25) return [SIDE_LONG]
  if (r < 0.50) return [SIDE_SHORT]
  return [SIDE_LONG, SIDE_SHORT]
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function loadConstants() {
  const [gb, bb, ef, mb] = await Promise.all([
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'GENESIS_BLOCK' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'BETTING_BLOCKS' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'ENTRY_FEE' }),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'MIN_BET' }),
  ])
  genesisBlock  = gb
  bettingBlocks = bb
  entryFee      = ef
  minBet        = mb

  if (nftAddress) {
    const bal = await publicClient.readContract({
      address: nftAddress, abi: NFT_ABI,
      functionName: 'balanceOf', args: [account.address],
    })
    holdsNft = bal > 0n
  }

  console.log(`Constants: GENESIS=${gb} BETTING=${bb} ENTRY_FEE=${formatEther(ef)} RON MIN_BET=${formatEther(mb)} RON`)
  console.log(`NFT holder: ${holdsNft} ${holdsNft ? '(no entry fee)' : `(+${formatEther(ef)} RON per bet)`}`)
}

// ── Bet placement ─────────────────────────────────────────────────────────────

async function placeBet(gameId: bigint, side: number, stake: bigint): Promise<void> {
  const label = side === SIDE_LONG ? '↑ LONG' : '↓ SHORT'
  // Non-NFT holders must send stake + entryFee; NFT holders stake only.
  const value = holdsNft ? stake : stake + entryFee
  try {
    const hash = await walletClient.writeContract({
      address: betPool,
      abi: BET_POOL_ABI,
      functionName: 'bet',
      args: [gameId, side],
      value,
    })
    console.log(`  bet ${label} ${formatEther(stake)} RON on game #${gameId} → ${hash}`)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  ✓ confirmed`)
  } catch (err: any) {
    console.log(`  bet ${label} game #${gameId} failed: ${err.shortMessage ?? err.message}`)
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick() {
  const [blockNumber, gameId] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'currentGameId' }),
  ])

  // Skip if we already bet on this game in this run.
  if (betOn.has(gameId)) {
    console.log(`[${ts()}] Block ${blockNumber} - game #${gameId} already bet, waiting for next game.`)
    return
  }

  // Skip if the betting window has closed.
  const closeBlock = genesisBlock + (gameId + 1n) * bettingBlocks
  if (blockNumber >= closeBlock) {
    console.log(`[${ts()}] Block ${blockNumber} - game #${gameId} betting window closed (closes at ${closeBlock}).`)
    return
  }

  // Confirm on-chain status is OPEN before spending gas.
  // getGame returns a positional tuple: [snapshotPrice, resolvedPrice, longStake, shortStake, fee, status, winningSide]
  const game   = await publicClient.readContract({ address: betPool, abi: BET_POOL_ABI, functionName: 'getGame', args: [gameId] })
  const status = game[5]
  if (status !== STATUS_OPEN) {
    console.log(`[${ts()}] Block ${blockNumber} - game #${gameId} is not open (status=${status}).`)
    return
  }

  const balance = await publicClient.getBalance({ address: account.address })
  const sides   = chooseSides()

  console.log(`[${ts()}] Block ${blockNumber} - game #${gameId}, sides: ${sides.map(s => s === SIDE_LONG ? 'LONG' : 'SHORT').join(' + ')}`)

  // Divide available balance evenly across the sides we're betting.
  // Available = balance − (entry fees for all sides) − gas buffer.
  const feePerBet    = holdsNft ? 0n : entryFee
  const totalFees    = feePerBet * BigInt(sides.length) + GAS_BUFFER
  const totalAvail   = balance > totalFees ? balance - totalFees : 0n
  const perSideAvail = sides.length > 0 ? totalAvail / BigInt(sides.length) : 0n

  if (perSideAvail < minBet) {
    console.log(`  Insufficient balance (${formatEther(balance)} RON, need at least ${formatEther(minBet + feePerBet + GAS_BUFFER)} RON per side). Skipping.`)
    betOn.add(gameId) // Don't retry - low balance won't improve until funded.
    return
  }

  // Clamp stake to [minRon, min(maxRon, perSideAvail)].
  const lo = minRon > perSideAvail ? perSideAvail : minRon
  const hi = maxRon > perSideAvail ? perSideAvail : maxRon

  for (const side of sides) {
    const stake = randBigInt(lo, hi)
    await placeBet(gameId, side, stake)
  }

  betOn.add(gameId)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Bot wallet: ${account.address}`)
  console.log(`BetPool:   ${betPool}`)
  console.log(`Side mode: ${sideMode} | Min: ${process.env.BOT_MIN_RON ?? 1} RON | Max: ${process.env.BOT_MAX_RON ?? 5} RON`)

  await loadConstants()

  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`Balance:   ${formatEther(balance)} RON`)

  if (onceMode) {
    await tick().catch(err => { console.error(err); process.exit(1) })
  } else {
    console.log(`\nBot daemon started. Polling every ${interval / 1000}s.`)
    const runLoop = async (): Promise<void> => {
      await tick().catch(err => console.error(`tick error: ${err.message}`))
      setTimeout(runLoop, interval)
    }
    await runLoop()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
