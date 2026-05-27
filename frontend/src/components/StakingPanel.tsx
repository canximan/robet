'use client'

import { useEffect, useRef, useState } from 'react'
import {
  useAccount, useChainId,
  useReadContracts, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { parseEther, formatEther, decodeEventLog } from 'viem'
import { ADDRESSES, STAKING_ABI, formatRon, explorerTxUrl } from '@/lib/contracts'

// Constants mirrored from the contract - only used to bootstrap before the
// first on-chain read returns. The UI always prefers values read from chain.
const FALLBACK_MIN_STAKE       = parseEther('100')
const FALLBACK_NFT_THRESHOLD   = parseEther('10000')
const FALLBACK_LOCK_PERIOD     = 24 * 60 * 60  // 1 day, seconds
const FALLBACK_MAX_SUPPLY      = 33_000n

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'ready'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  const s = Math.max(0, seconds % 60)
  return `${m}m ${s}s`
}

function bpsToPct(bps: bigint): string {
  const v = Number(bps) / 100
  return `${v.toFixed(2)} %`
}

function formatDate(ts: number): string {
  if (ts <= 0) return '-'
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function StakingPanel() {
  const { address } = useAccount()
  const chainId = useChainId()

  // ── Reads ───────────────────────────────────────────────────────────────────
  // Split into two hooks so wagmi can infer fixed tuple lengths cleanly.
  const { data: globalReads, refetch: refetchGlobal } = useReadContracts({
    contracts: [
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'totalStaked'    },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'nftsMinted'     },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'currentProbBps' },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'MIN_STAKE'      },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'NFT_THRESHOLD'  },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'LOCK_PERIOD'    },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'MAX_SUPPLY'     },
    ],
    query: { refetchInterval: 15_000 },
  })

  const { data: userReads, refetch: refetchUser } = useReadContracts({
    contracts: [
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'stakes',        args: [address!] },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'pendingReward', args: [address!] },
    ],
    query: { enabled: !!address, refetchInterval: 15_000 },
  })

  const refetch = () => { refetchGlobal(); refetchUser() }

  const totalStaked  = (globalReads?.[0]?.result ?? 0n) as bigint
  const nftsMinted   = (globalReads?.[1]?.result ?? 0n) as bigint
  const probBps      = (globalReads?.[2]?.result ?? 0n) as bigint
  const minStake     = (globalReads?.[3]?.result ?? FALLBACK_MIN_STAKE)     as bigint
  const nftThreshold = (globalReads?.[4]?.result ?? FALLBACK_NFT_THRESHOLD) as bigint
  const lockPeriod   = Number(globalReads?.[5]?.result ?? BigInt(FALLBACK_LOCK_PERIOD))
  const maxSupply    = (globalReads?.[6]?.result ?? FALLBACK_MAX_SUPPLY)    as bigint

  const stakeTuple   = userReads?.[0]?.result as readonly [bigint, bigint, bigint] | undefined
  const stakedAmount = stakeTuple?.[0] ?? 0n
  const stakedAt     = stakeTuple?.[1] ?? 0n
  const pendingPod   = (userReads?.[1]?.result ?? 0n) as bigint

  // ── Local clock for live countdown ─────────────────────────────────────────
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Derived values ─────────────────────────────────────────────────────────
  const supplyPct       = maxSupply > 0n ? Number(nftsMinted * 10000n / maxSupply) / 100 : 0
  const stakedAtSec     = Number(stakedAt)
  const lockEnd         = stakedAtSec === 0 ? 0 : stakedAtSec + lockPeriod
  const lockRemaining   = Math.max(0, lockEnd - now)
  const lockProgress    = lockPeriod > 0 && stakedAtSec > 0
    ? Math.min(100, ((now - stakedAtSec) / lockPeriod) * 100)
    : 0
  const eligibleForRoll = stakedAmount >= minStake && stakedAtSec > 0 && lockRemaining === 0

  const sharePct  = totalStaked > 0n && stakedAmount > 0n
    ? Number(stakedAmount * 10000n / totalStaked) / 100
    : 0

  const diceRolls = nftThreshold > 0n
    ? Number(stakedAmount / nftThreshold)
    : 0
  // Expected NFTs per claim attempt (informational only).
  const expectedMintsPerClaim = diceRolls * (Number(probBps) / 10000)

  // ── Write (single useWriteContract shared across all four actions) ─────────
  const [stakeInput,   setStakeInput]   = useState('')
  const [unstakeInput, setUnstakeInput] = useState('')

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({ hash: txHash })
  const busy = isPending || isConfirming

  // Track which action a tx belongs to (plus the amount, for history logging).
  type PendingAction =
    | { kind: 'stake';       amount: bigint }
    | { kind: 'unstake';     amount: bigint }
    | { kind: 'claimReward'; amount: bigint }
    | { kind: 'roll' }
  const pendingAction = useRef<PendingAction | null>(null)

  // Last claim outcome - parsed from the receipt's ClaimResult event.
  const [lastRollOutcome, setLastRollOutcome] = useState<{ rolls: number; minted: number; tx: string } | null>(null)

  useEffect(() => {
    if (!isSuccess || !receipt) return
    refetch()

    const action = pendingAction.current
    if (action?.kind === 'roll') {
      // Roll: scan logs for ClaimResult event to populate the outcome toast.
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({
            abi: STAKING_ABI,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName === 'ClaimResult') {
            const { rolls, minted } = decoded.args as { rolls: bigint; minted: bigint }
            setLastRollOutcome({ rolls: Number(rolls), minted: Number(minted), tx: receipt.transactionHash })
            break
          }
        } catch {
          // Not a STAKING_ABI event, skip
        }
      }
    } else if (action && address) {
      // Stake / unstake / claim-reward: record in the unified claim history.
      // Kind label is 'stake-pod' for reward claims to distinguish from game-side PoD.
      const apiKind =
        action.kind === 'stake'       ? 'stake'
      : action.kind === 'unstake'     ? 'unstake'
      :                                 'stake-pod'
      fetch('/api/pod-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          kind:   apiKind,
          amount: action.amount.toString(),
          txHash: receipt.transactionHash,
        }),
      }).catch(() => {})
    }
    pendingAction.current = null
  }, [isSuccess, receipt])

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleStake() {
    if (!stakeInput) return
    const amount = parseEther(stakeInput)
    pendingAction.current = { kind: 'stake', amount }
    writeContract({
      address: ADDRESSES.staking, abi: STAKING_ABI,
      functionName: 'stake',
      value: amount,
    })
    setStakeInput('')
  }

  function handleUnstake() {
    if (!unstakeInput) return
    const amount = parseEther(unstakeInput)
    pendingAction.current = { kind: 'unstake', amount }
    writeContract({
      address: ADDRESSES.staking, abi: STAKING_ABI,
      functionName: 'unstake',
      args: [amount],
    })
    setUnstakeInput('')
  }

  function handleRoll() {
    setLastRollOutcome(null)
    pendingAction.current = { kind: 'roll' }
    writeContract({
      address: ADDRESSES.staking, abi: STAKING_ABI,
      functionName: 'claimAndRestake',
    })
  }

  function handleClaimReward() {
    // Snapshot the pending PoD amount at click time so we can record the
    // claimed amount in history once the tx confirms.
    pendingAction.current = { kind: 'claimReward', amount: pendingPod }
    writeContract({
      address: ADDRESSES.staking, abi: STAKING_ABI,
      functionName: 'claimReward',
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">

      {/* Global schedule */}
      <div className="border border-border rounded-xl p-5 bg-card flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">NFT emission schedule</h2>
          <span className="text-xs text-muted font-mono">{bpsToPct(probBps)} / roll</span>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5 text-xs">
            <span className="text-muted">Minted by staking</span>
            <span className="font-mono">
              <span className="text-white">{nftsMinted.toLocaleString()}</span>
              <span className="text-muted"> / {maxSupply.toLocaleString()}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-border overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${supplyPct}%` }} />
          </div>
        </div>

        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">Total staked in pool</span>
          <span className="font-mono text-white">{formatRon(totalStaked)}</span>
        </div>
      </div>

      {/* Your position */}
      {!address ? (
        <div className="text-center py-10 text-muted border border-border rounded-xl bg-card">
          <p className="text-4xl mb-3">👛</p>
          <p className="font-medium">Connect a wallet to stake.</p>
        </div>
      ) : (
        <div className="border border-border rounded-xl p-5 bg-card flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Your stake</h2>
            {stakedAmount > 0n && (
              <span className="text-xs text-muted font-mono">
                {diceRolls > 0 ? `${diceRolls} 🎲 / claim` : 'PoD only'}
              </span>
            )}
          </div>

          {stakedAmount === 0n ? (
            <p className="text-sm text-muted">
              You aren&apos;t staked. Stake at least <span className="text-white font-medium">{formatRon(minStake)}</span> to
              earn a share of the 60 % PoD allocation routed to this pool.
              Every <span className="text-white font-medium">{formatRon(nftThreshold)}</span> staked grants one dice roll
              for a chance to mint a Robet NFT each lock cycle.
            </p>
          ) : (
            <>
              {/* ── Position summary ── */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-bg rounded-lg py-2 px-1">
                  <p className="text-[10px] text-muted mb-0.5">Staked</p>
                  <p className="text-sm font-semibold font-mono text-white truncate">{formatRon(stakedAmount, 0)}</p>
                </div>
                <div className="bg-bg rounded-lg py-2 px-1">
                  <p className="text-[10px] text-muted mb-0.5">Pool share</p>
                  <p className="text-sm font-semibold font-mono text-white">{sharePct.toFixed(2)} %</p>
                </div>
                <div className="bg-bg rounded-lg py-2 px-1">
                  <p className="text-[10px] text-muted mb-0.5">Dice rolls</p>
                  <p className="text-sm font-semibold font-mono text-white">{diceRolls > 0 ? `${diceRolls} 🎲` : '—'}</p>
                </div>
              </div>

              {/* ── Staking rewards (lead section) ── */}
              <div className="flex flex-col gap-2 pt-1 border-t border-border">
                <div className="flex items-baseline justify-between text-xs text-muted">
                  <span>Reward source</span>
                  <span>60 % of protocol PoD sweep · pro-rata by stake</span>
                </div>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-muted">Claimable now</span>
                  <span className="font-mono text-purple-400 font-semibold text-base">{formatRon(pendingPod)}</span>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  Rewards accumulate each time the off-chain sweeper forwards the PoD batch.
                  Claiming does not reset your lock or dice-roll progress.
                </p>
                <button
                  disabled={busy || pendingPod === 0n}
                  onClick={handleClaimReward}
                  className="w-full py-2.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors"
                >
                  {busy && pendingAction.current?.kind === 'claimReward'
                    ? 'Claiming…'
                    : pendingPod === 0n
                      ? 'Nothing to claim yet'
                      : `Claim ${formatRon(pendingPod)}`}
                </button>
              </div>

              {/* ── NFT dice roll ── */}
              {stakedAmount >= minStake && (
                <div className="flex flex-col gap-2 pt-1 border-t border-border">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-medium">NFT dice roll</span>
                    <span className="text-muted">
                      {eligibleForRoll
                        ? <span className="text-over">ready</span>
                        : <>unlocks <span className="text-white font-mono">{formatDate(lockEnd)}</span></>}
                    </span>
                  </div>

                  {diceRolls === 0 ? (
                    <div className="text-xs border border-yellow-500/30 bg-yellow-500/5 rounded-lg px-3 py-2 text-yellow-300">
                      Stake <span className="font-mono">{formatRon(nftThreshold - stakedAmount)}</span> more to unlock 1 dice roll per cycle.
                    </div>
                  ) : (
                    <>
                      <div className="h-1.5 rounded-full bg-border overflow-hidden">
                        <div
                          className={`h-full transition-all ${eligibleForRoll ? 'bg-over' : 'bg-accent'}`}
                          style={{ width: `${lockProgress}%` }}
                        />
                      </div>
                      <div className="flex items-baseline justify-between text-xs text-muted">
                        <span>{formatDuration(lockRemaining)} remaining</span>
                        <span>≈ <span className="text-white font-mono">{expectedMintsPerClaim.toFixed(2)}</span> NFTs / roll · {bpsToPct(probBps)} chance</span>
                      </div>
                      <button
                        disabled={busy || !eligibleForRoll}
                        onClick={handleRoll}
                        className="w-full py-2.5 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {busy && pendingAction.current?.kind === 'roll'
                          ? 'Rolling…'
                          : eligibleForRoll
                            ? `🎲 Roll ${diceRolls} ${diceRolls === 1 ? 'die' : 'dice'} & restake`
                            : `🔒 ${formatDuration(lockRemaining)} left`}
                      </button>
                    </>
                  )}

                  {lastRollOutcome && (
                    <div className={`text-sm border rounded-lg px-4 py-3 ${
                      lastRollOutcome.minted > 0
                        ? 'border-over/40 bg-over/10 text-over'
                        : 'border-border bg-bg text-muted'
                    }`}>
                      {lastRollOutcome.minted > 0
                        ? <span>🎉 Minted <span className="font-semibold">{lastRollOutcome.minted}</span> NFT{lastRollOutcome.minted > 1 ? 's' : ''} from {lastRollOutcome.rolls} rolls</span>
                        : <span>No luck — {lastRollOutcome.rolls} {lastRollOutcome.rolls === 1 ? 'roll' : 'rolls'}, 0 mints.</span>}
                      {' '}
                      <a href={explorerTxUrl(lastRollOutcome.tx, chainId)} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">tx ↗</a>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Stake / unstake forms */}
      {address && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="border border-border rounded-xl p-4 bg-card flex flex-col gap-2">
            <p className="text-xs text-muted">Stake more RON</p>
            <div className="flex gap-2">
              <input
                type="number" min="0" step="100" placeholder="Amount"
                value={stakeInput}
                onChange={e => setStakeInput(e.target.value)}
                className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                disabled={busy || !stakeInput || parseFloat(stakeInput) <= 0}
                onClick={handleStake}
                className="px-4 py-2 rounded-lg bg-over text-black text-sm font-semibold disabled:opacity-50 transition-colors"
              >
                {busy && pendingAction.current?.kind === 'stake' ? '…' : 'Stake'}
              </button>
            </div>
            {stakedAmount === 0n && stakeInput && parseFloat(stakeInput) < Number(formatEther(minStake)) && (
              <p className="text-xs text-yellow-400">First stake must be ≥ {formatRon(minStake)}.</p>
            )}
          </div>

          <div className="border border-border rounded-xl p-4 bg-card flex flex-col gap-2">
            <p className="text-xs text-muted">Unstake (any time)</p>
            <div className="flex gap-2">
              <input
                type="number" min="0" step="100" placeholder="Amount"
                value={unstakeInput}
                onChange={e => setUnstakeInput(e.target.value)}
                className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                disabled={busy || !unstakeInput || parseFloat(unstakeInput) <= 0 || stakedAmount === 0n}
                onClick={handleUnstake}
                className="px-4 py-2 rounded-lg bg-under text-white text-sm font-semibold disabled:opacity-50 transition-colors"
              >
                {busy && pendingAction.current?.kind === 'unstake' ? '…' : 'Unstake'}
              </button>
            </div>
            {stakedAmount > 0n && lockRemaining > 0 && (
              <p className="text-xs text-muted">Unstaking now forfeits this round&apos;s dice roll.</p>
            )}
          </div>
        </div>
      )}

      {writeError && (
        <p className="text-xs text-red-400 px-1 break-all">
          {(writeError as { shortMessage?: string }).shortMessage ?? writeError.message}
        </p>
      )}
    </div>
  )
}
