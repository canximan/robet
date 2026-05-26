/**
 * PoD sweeper - watches the treasury wallet for accumulated RON from Ronin's
 * Proof of Distribution and routes it three ways:
 *
 *   30 % → BetPool.sweep()       (80 % losers · 20 % winners)
 *   60 % → Staking.sweep()       (pro-rata to RON stakers)
 *   10 % → TREASURY_ADDRESS      (cold-wallet protocol cut, plain transfer)
 *
 * Modes:
 *   --once    single pass then exit (cron / CI)
 *   (default) daemon, polling every SWEEP_INTERVAL_MS (default 600 000 = 10 min)
 *
 * Required env:
 *   TREASURY_PRIVATE_KEY  hot key of the PoD receiver wallet
 *   RONIN_RPC_URL         Ronin RPC endpoint
 *   BET_POOL_ADDRESS      deployed BetPool proxy
 *   STAKING_ADDRESS       deployed Staking contract
 *   TREASURY_ADDRESS      cold wallet that takes the 10 % cut
 *
 * Optional:
 *   MIN_SWEEP_RON         minimum balance before sweeping  (default 1)
 *   MAX_SWEEP_RON         per-tick cap                     (default 100)
 *   SWEEP_INTERVAL_MS     daemon polling cadence in ms     (default 600000)
 */

import {
  createPublicClient, createWalletClient,
  http, parseAbi, parseEther, formatEther, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'

const ronin = defineChain({
  id: Number(process.env.CHAIN_ID ?? 2020),
  name: 'Ronin',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RONIN_RPC_URL ?? 'https://api.roninchain.com/rpc'] } },
})

const SWEEP_ABI = parseAbi(['function sweep() external payable'])

// ── Split (basis points) ───────────────────────────────────────────────────────
const BPS_BETPOOL  = 3000n   // 30 %
const BPS_STAKING  = 6000n   // 60 %
// Treasury gets the remainder after the two contract sweeps (10 %).

const betPool   = process.env.BET_POOL_ADDRESS as Hex
const staking   = process.env.STAKING_ADDRESS  as Hex
const treasury  = process.env.TREASURY_ADDRESS as Hex
const account   = privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as Hex)
const minSweep  = parseEther(process.env.MIN_SWEEP_RON ?? '1')
const maxSweep  = parseEther(process.env.MAX_SWEEP_RON ?? '100')
const onceMode  = process.argv.includes('--once')
const interval  = Number(process.env.SWEEP_INTERVAL_MS ?? 600_000)

// Three txs per sweep: ~50k gas each at ~20 gwei = ~0.003 RON. 0.02 buffer is safe.
const GAS_BUFFER = parseEther('0.02')

const publicClient = createPublicClient({ chain: ronin, transport: http() })
const walletClient = createWalletClient({ chain: ronin, transport: http(), account })

function ts() { return new Date().toISOString() }

async function tick() {
  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`[${ts()}] PoD wallet ${account.address} balance: ${formatEther(balance)} RON`)

  if (balance < minSweep) {
    console.log(`  Below min sweep threshold (${formatEther(minSweep)} RON) - skipping`)
    return
  }

  // Total amount to dispatch this tick (capped by maxSweep, leaving GAS_BUFFER for gas).
  let dispatch: bigint
  if (balance > maxSweep + GAS_BUFFER) dispatch = maxSweep
  else                                 dispatch = balance - GAS_BUFFER

  if (dispatch <= 0n) {
    console.log(`  Not enough to cover gas buffer - skipping`)
    return
  }

  const toBetPool  = dispatch * BPS_BETPOOL / 10_000n
  const toStaking  = dispatch * BPS_STAKING / 10_000n
  const toTreasury = dispatch - toBetPool - toStaking   // remainder = 10 %

  console.log(`  Dispatching ${formatEther(dispatch)} RON:`)
  console.log(`    → BetPool   ${formatEther(toBetPool)}  (30 %)`)
  console.log(`    → Staking   ${formatEther(toStaking)}  (60 %)`)
  console.log(`    → Treasury  ${formatEther(toTreasury)}  (10 %)`)

  // Sequential txs so failures are isolated and nonce ordering is deterministic.
  try {
    if (toBetPool > 0n && betPool) {
      const h = await walletClient.writeContract({
        address: betPool, abi: SWEEP_ABI, functionName: 'sweep', value: toBetPool,
      })
      console.log(`    BetPool tx ${h}`)
      await publicClient.waitForTransactionReceipt({ hash: h })
    }

    if (toStaking > 0n && staking) {
      const h = await walletClient.writeContract({
        address: staking, abi: SWEEP_ABI, functionName: 'sweep', value: toStaking,
      })
      console.log(`    Staking tx ${h}`)
      await publicClient.waitForTransactionReceipt({ hash: h })
    }

    if (toTreasury > 0n && treasury) {
      const h = await walletClient.sendTransaction({ to: treasury, value: toTreasury })
      console.log(`    Treasury tx ${h}`)
      await publicClient.waitForTransactionReceipt({ hash: h })
    }

    console.log(`  ✓ sweep complete`)
  } catch (err: any) {
    console.error(`  ✗ sweep failed: ${err.shortMessage ?? err.message}`)
  }
}

if (onceMode) {
  tick().catch(err => { console.error(err); process.exit(1) })
} else {
  console.log(`Sweeper daemon started. PoD wallet: ${account.address} | Polling every ${interval / 1000}s`)
  tick()
  setInterval(tick, interval)
}
