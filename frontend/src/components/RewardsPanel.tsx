'use client'

import { useEffect, useRef, useState } from 'react'
import {
  useAccount, useReadContract, useReadContracts,
  useWriteContract, useWaitForTransactionReceipt, useChainId,
} from 'wagmi'
import {
  ADDRESSES,
  BET_POOL_ABI, REWARD_DISTRIBUTOR_ABI, STAKING_ABI,
  SIDE, formatRon, explorerAddressUrl, explorerTxUrl,
} from '@/lib/contracts'

type GameClaimType = 'loser' | 'winner'
type Row = { gameId: bigint; type: GameClaimType; amount: bigint }
type PendingClaim =
  | { kind: 'game';    row: Row }
  | { kind: 'staking'; amount: bigint }

type HistoryKind = 'pot' | 'rebate' | 'bonus' | 'stake' | 'unstake' | 'stake-pod'
type HistoryItem = {
  gameId: string
  kind: HistoryKind
  amount: string
  txHash: string
  claimedAt: string
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold font-mono">{value}</p>
      {hint && <p className="text-[10px] text-muted/70 leading-tight">{hint}</p>}
    </div>
  )
}

function PendingRow({
  gameId, type, amount, onClaim, busy,
}: {
  gameId: bigint
  type: GameClaimType
  amount: bigint
  onClaim: () => void
  busy: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
      <div>
        <p className="text-sm">
          <span className="text-muted font-mono">Game #{gameId.toString()}</span>
          {' - '}
          <span className={type === 'loser' ? 'text-purple-400' : 'text-over'}>
            {type === 'loser' ? 'PoD rebate (loser)' : 'PoD bonus (winner)'}
          </span>
        </p>
        <p className="text-base font-semibold mt-0.5">{formatRon(amount)}</p>
      </div>
      <button
        disabled={busy}
        onClick={onClaim}
        className="px-4 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 border-purple-500/40 text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
      >
        {busy ? 'Claiming…' : 'Claim'}
      </button>
    </div>
  )
}

export function RewardsPanel() {
  const { address } = useAccount()
  const chainId     = useChainId()

  // ── BetPool global stats ─────────────────────────────────────────────────
  const { data: totalReceived }       = useReadContract({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'totalReceived',       query: { refetchInterval: 15_000 } })
  const { data: totalCumulativeLoss } = useReadContract({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'totalCumulativeLoss', query: { refetchInterval: 15_000 } })
  const { data: totalCumulativeWin }  = useReadContract({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'totalCumulativeWin',  query: { refetchInterval: 15_000 } })

  // ── Staking global stats ─────────────────────────────────────────────────
  const { data: stakingGlobal, refetch: refetchStakingGlobal } = useReadContracts({
    contracts: [
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'totalStaked' },
    ],
    query: { refetchInterval: 15_000 },
  })
  const totalStaked = (stakingGlobal?.[0]?.result ?? 0n) as bigint

  // ── Staking user data ────────────────────────────────────────────────────
  const { data: stakingUser, refetch: refetchStakingUser } = useReadContracts({
    contracts: [
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'stakes',        args: [address!] },
      { address: ADDRESSES.staking, abi: STAKING_ABI, functionName: 'pendingReward', args: [address!] },
    ],
    query: { enabled: !!address, refetchInterval: 10_000 },
  })
  const stakeTuple   = stakingUser?.[0]?.result as readonly [bigint, bigint, bigint] | undefined
  const myStake      = stakeTuple?.[0] ?? 0n
  const myStakingPod = (stakingUser?.[1]?.result ?? 0n) as bigint
  const mySharePct   = totalStaked > 0n ? Number(myStake * 10000n / totalStaked) / 100 : 0

  // ── BetPool user pending rebates/bonuses ─────────────────────────────────
  const { data: currentGameId } = useReadContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'currentGameId' })
  const gameCount = Number(currentGameId ?? 0n) + 1
  const gameIds   = Array.from({ length: gameCount }, (_, i) => BigInt(i))

  const { data: userLongRaw } = useReadContracts({
    contracts: gameIds.map(id => ({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'userStake' as const, args: [id, address!, BigInt(SIDE.LONG)] as const })),
    query: { enabled: !!address && gameCount > 0 },
  })
  const { data: userShortRaw } = useReadContracts({
    contracts: gameIds.map(id => ({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'userStake' as const, args: [id, address!, BigInt(SIDE.SHORT)] as const })),
    query: { enabled: !!address && gameCount > 0 },
  })

  const myGameIds = gameIds.filter((_, i) =>
    (userLongRaw?.[i]?.result ?? 0n) > 0n || (userShortRaw?.[i]?.result ?? 0n) > 0n
  )

  const { data: pendingLoserRaw } = useReadContracts({
    contracts: myGameIds.map(id => ({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'pendingLoserRebate' as const, args: [id, address!] as const })),
    query: { enabled: !!address && myGameIds.length > 0, refetchInterval: 15_000 },
  })
  const { data: pendingWinnerRaw } = useReadContracts({
    contracts: myGameIds.map(id => ({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'pendingWinnerBonus' as const, args: [id, address!] as const })),
    query: { enabled: !!address && myGameIds.length > 0, refetchInterval: 15_000 },
  })

  const claimable: Row[] = []
  myGameIds.forEach((gameId, i) => {
    const loser  = pendingLoserRaw?.[i]?.result  ?? 0n
    const winner = pendingWinnerRaw?.[i]?.result ?? 0n
    if (loser  > 0n) claimable.push({ gameId, type: 'loser',  amount: loser  })
    if (winner > 0n) claimable.push({ gameId, type: 'winner', amount: winner })
  })
  const totalGamePending = claimable.reduce((sum, r) => sum + r.amount, 0n)

  // ── Claim history (file-backed API; only tracks game-side claims) ────────
  const [history, setHistory] = useState<HistoryItem[]>([])
  function fetchHistory() {
    if (!address) return
    fetch(`/api/pod-claims?address=${address}`).then(r => r.json()).then(setHistory).catch(() => {})
  }
  useEffect(() => { setHistory([]); fetchHistory() }, [address])

  // ── Single write hook shared by game + staking claims ────────────────────
  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({ hash: txHash })
  const busy = isPending || isConfirming

  const pendingClaimRef = useRef<PendingClaim | null>(null)

  useEffect(() => {
    if (!isSuccess || !receipt || !pendingClaimRef.current || !address) return
    const claim = pendingClaimRef.current

    if (claim.kind === 'game') {
      fetch('/api/pod-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          gameId: claim.row.gameId.toString(),
          kind:   claim.row.type === 'loser' ? 'rebate' : 'bonus',
          amount: claim.row.amount.toString(),
          txHash: receipt.transactionHash,
        }),
      }).then(() => fetchHistory()).catch(() => {})
    } else {
      // Staking PoD claim — record under 'stake-pod' (no gameId).
      refetchStakingGlobal()
      refetchStakingUser()
      fetch('/api/pod-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          kind:   'stake-pod',
          amount: claim.amount.toString(),
          txHash: receipt.transactionHash,
        }),
      }).then(() => fetchHistory()).catch(() => {})
    }
    pendingClaimRef.current = null
  }, [isSuccess])

  function claimGame(row: Row) {
    pendingClaimRef.current = { kind: 'game', row }
    writeContract({
      address: ADDRESSES.rewardDistributor,
      abi: REWARD_DISTRIBUTOR_ABI,
      functionName: row.type === 'loser' ? 'claimLoserRebate' : 'claimWinnerBonus',
      args: [row.gameId],
    })
  }

  function claimStaking() {
    // Snapshot pending so we can record it post-confirmation.
    pendingClaimRef.current = { kind: 'staking', amount: myStakingPod }
    writeContract({
      address: ADDRESSES.staking,
      abi: STAKING_ABI,
      functionName: 'claimReward',
    })
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-6">

      {/* How PoD flows */}
      <section>
        <h2 className="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
          Proof of Distribution
        </h2>

        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
            <p className="text-xs text-muted">→ BetPool</p>
            <p className="text-lg font-semibold font-mono text-over">30 %</p>
            <p className="text-xs text-muted leading-snug">80 % losers · 20 % winners</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
            <p className="text-xs text-muted">→ Staking</p>
            <p className="text-lg font-semibold font-mono text-purple-400">60 %</p>
            <p className="text-xs text-muted leading-snug">pro-rata to all RON stakers</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
            <p className="text-xs text-muted">→ Treasury</p>
            <p className="text-lg font-semibold font-mono text-muted">10 %</p>
            <p className="text-xs text-muted leading-snug">protocol cut</p>
          </div>
        </div>
        <p className="text-xs text-muted mt-2 leading-relaxed">
          Ronin PoD inflows land on the treasury EOA below. The off-chain sweeper splits each tick:
          30 % to BetPool, 60 % to Staking, 10 % kept as protocol revenue.
        </p>

        <div className="mt-4 flex items-center gap-2 bg-card border border-border rounded-xl px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted mb-0.5">PoD Treasury wallet</p>
            <p className="font-mono text-sm truncate">{ADDRESSES.treasury}</p>
          </div>
          <a
            href={explorerAddressUrl(ADDRESSES.treasury, chainId)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 px-3 py-1.5 rounded-lg border border-border text-xs text-muted hover:text-white hover:border-accent transition-colors"
          >
            View history ↗
          </a>
        </div>
      </section>

      {/* ── Stake PoD ───────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-widest">
            Stake PoD <span className="text-muted/60">· pro-rata</span>
          </h2>
          {address && myStakingPod > 0n && (
            <span className="text-sm font-semibold text-purple-400">{formatRon(myStakingPod)}</span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <StatBox
            label="Total staked"
            value={formatRon(totalStaked)}
            hint="Current pool size"
          />
          <StatBox
            label="Your share"
            value={myStake > 0n ? `${mySharePct.toFixed(2)} %` : '-'}
            hint={myStake > 0n ? `${formatRon(myStake)} staked` : 'No active stake'}
          />
        </div>

        {!address ? (
          <p className="text-sm text-muted text-center py-6">Connect your wallet to see your staking rewards.</p>
        ) : myStake === 0n ? (
          <p className="text-sm text-muted text-center py-6">
            You have no active stake. Stake in the <span className="text-white font-medium">Stake</span> tab
            to start earning a share of staking PoD.
          </p>
        ) : (
          <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-3">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted">Claimable now</span>
              <span className="font-mono text-purple-400 font-semibold text-base">{formatRon(myStakingPod)}</span>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              Updates every time the sweeper forwards a PoD batch to the staking contract.
              Claiming does not affect your stake or dice-roll progress.
            </p>
            <button
              disabled={busy || myStakingPod === 0n}
              onClick={claimStaking}
              className="w-full py-2.5 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors"
            >
              {busy ? 'Claiming…' : myStakingPod === 0n ? 'Nothing to claim' : `Claim ${formatRon(myStakingPod)}`}
            </button>
          </div>
        )}
      </section>

      {/* ── Game PoD (BetPool) ──────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-widest">
            Game PoD <span className="text-muted/60">· BetPool</span>
          </h2>
          {address && claimable.length > 0 && (
            <span className="text-sm font-semibold text-purple-400">{formatRon(totalGamePending)}</span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <StatBox label="BetPool PoD in"       value={totalReceived       != null ? formatRon(totalReceived)       : '-'} />
          <StatBox label="Total losses tracked" value={totalCumulativeLoss != null ? formatRon(totalCumulativeLoss) : '-'} />
          <StatBox label="Total wins tracked"   value={totalCumulativeWin  != null ? formatRon(totalCumulativeWin)  : '-'} />
        </div>

        {!address ? (
          <p className="text-sm text-muted text-center py-6">Connect your wallet to see your game rewards.</p>
        ) : claimable.length === 0 ? (
          <p className="text-sm text-muted text-center py-6">
            No pending game rewards. Loser rebates and winner bonuses appear here after a game resolves
            and the next sweep arrives.
          </p>
        ) : (
          <div className="bg-card border border-border rounded-xl px-5">
            {claimable.map(row => (
              <PendingRow
                key={`${row.gameId}-${row.type}`}
                gameId={row.gameId}
                type={row.type}
                amount={row.amount}
                onClaim={() => claimGame(row)}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      {/* Claim history — both game-side and staking-side actions */}
      {address && (
        <section>
          <h2 className="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
            History
          </h2>
          {history.length === 0 ? (
            <p className="text-sm text-muted text-center py-6">No activity yet.</p>
          ) : (
            <div className="bg-card border border-border rounded-xl px-5">
              {history.map((item, i) => {
                // Per-kind labels and colours. Outflows (stake) are red-tinted
                // since RON leaves the wallet; everything else is an inflow.
                const meta: Record<HistoryKind, { source: string; label: string; color: string; sign: string }> = {
                  'pot':       { source: `Game #${item.gameId}`, label: 'Pot claim',      color: 'text-over',     sign: '+' },
                  'rebate':    { source: `Game #${item.gameId}`, label: 'PoD rebate',     color: 'text-purple-400', sign: '+' },
                  'bonus':     { source: `Game #${item.gameId}`, label: 'PoD bonus',      color: 'text-purple-400', sign: '+' },
                  'stake':     { source: 'Staking',              label: 'Staked',         color: 'text-under',    sign: '−' },
                  'unstake':   { source: 'Staking',              label: 'Unstaked',       color: 'text-over',     sign: '+' },
                  'stake-pod': { source: 'Staking',              label: 'PoD claim',      color: 'text-purple-400', sign: '+' },
                }
                const m = meta[item.kind] ?? { source: '?', label: item.kind, color: 'text-muted', sign: '' }
                return (
                  <div key={i} className="flex items-center justify-between gap-4 py-3 border-b border-border last:border-0">
                    <div>
                      <p className="text-sm">
                        <span className="text-muted font-mono">{m.source}</span>
                        {' - '}
                        <span className={m.color}>{m.label}</span>
                      </p>
                      <p className="text-xs text-muted mt-0.5">{new Date(item.claimedAt).toLocaleString()}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`font-semibold text-sm ${m.color}`}>
                        {m.sign}{formatRon(BigInt(item.amount))}
                      </p>
                      <a
                        href={explorerTxUrl(item.txHash, chainId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted hover:text-accent transition-colors"
                      >
                        tx ↗
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {writeError && (
        <p className="text-xs text-red-400 px-1 break-all">
          {(writeError as { shortMessage?: string }).shortMessage ?? writeError.message}
        </p>
      )}
    </div>
  )
}
