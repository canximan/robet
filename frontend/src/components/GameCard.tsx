'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseEther } from 'viem'
import {
  ADDRESSES, BET_POOL_ABI, ROBET_NFT_ABI, REWARD_DISTRIBUTOR_ABI,
  STATUS, SIDE, formatPrice, formatRon, formatCountdown,
  ENTRY_FEE, explorerTxUrl, explorerBlockUrl,
} from '@/lib/contracts'
import { GameRulesButton } from '@/components/GameRules'

type Game = {
  snapshotPrice: bigint
  resolvedPrice: bigint
  totalLongStake: bigint
  totalShortStake: bigint
  feeCollected: bigint
  status: number
  winningSide: number
}

function PotBar({ long, short }: { long: bigint; short: bigint }) {
  const total = long + short
  if (total === 0n) return <div className="h-1.5 rounded-full bg-border w-full" />
  const longPct = Math.round(Number(long * 100n / total))
  return (
    <div className="h-1.5 rounded-full bg-under/40 w-full overflow-hidden">
      <div className="h-full bg-over rounded-full transition-all" style={{ width: `${longPct}%` }} />
    </div>
  )
}

// Phase the UI cares about, derived from block numbers + on-chain status.
type Phase =
  | 'betting'           // current game, accepting bets
  | 'snapshot-window'   // betting closed, waiting for keeper to snapshot
  | 'snapshot-missed'   // snapshot window closed with no snapshot - can expire now
  | 'hold'              // snapshot taken, waiting for resolution
  | 'resolution-window' // resolution window open (keeper + users can resolve)
  | 'settled'           // RESOLVED, REFUNDED, or EXPIRED

function derivePhase(
  game: Game, gameId: bigint, currentBlock: bigint,
  genesisBlock: bigint, bettingBlocks: bigint, holdBlocks: bigint,
): Phase {
  if (game.status !== STATUS.OPEN) return 'settled'

  const closeBlock = genesisBlock + (gameId + 1n) * bettingBlocks
  const resBlock   = closeBlock + holdBlocks

  if (currentBlock < closeBlock)        return 'betting'
  if (currentBlock < closeBlock + 10n)  return 'snapshot-window'
  if (game.snapshotPrice === 0n)        return 'snapshot-missed'
  if (currentBlock < resBlock)          return 'hold'
  if (currentBlock < resBlock + 30n)    return 'resolution-window'
  return 'settled'
}

export function GameCard({
  gameId,
  game,
  genesisBlock,
  bettingBlocks,
  holdBlocks,
  currentBlock,
  userLongStake,
  userShortStake,
  onTxSuccess,
}: {
  gameId: bigint
  game: Game
  genesisBlock: bigint
  bettingBlocks: bigint
  holdBlocks: bigint
  currentBlock: bigint
  userLongStake: bigint
  userShortStake: bigint
  onTxSuccess?: () => void
}) {
  const { address } = useAccount()
  const chainId = useChainId()

  const { data: nftBalance } = useReadContract({
    address: ADDRESSES.robetNft,
    abi: ROBET_NFT_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  })
  const holdsNft = (nftBalance ?? 0n) > 0n
  const [stakeInput, setStakeInput] = useState('')
  const [choosingSide, setChoosingSide] = useState<number | null>(null)
  const [gameTxs, setGameTxs] = useState<{ snapshotTx?: string; resolveTx?: string }>({})

  const phase = derivePhase(game, gameId, currentBlock, genesisBlock, bettingBlocks, holdBlocks)

  useEffect(() => {
    fetch(`/api/game-txs/${gameId}`)
      .then(r => r.json())
      .then(setGameTxs)
      .catch(() => {})
  }, [gameId])

  const openBlock      = genesisBlock + gameId * bettingBlocks
  const closeBlock     = genesisBlock + (gameId + 1n) * bettingBlocks
  const resBlock       = closeBlock + holdBlocks
  const bettingLeft    = closeBlock > currentBlock ? closeBlock - currentBlock : 0n
  const resolutionLeft = resBlock   > currentBlock ? resBlock   - currentBlock : 0n

  const { data: hasClaimed } = useReadContract({
    address: ADDRESSES.betPool,
    abi: BET_POOL_ABI,
    functionName: 'claimed',
    args: [gameId, address!],
    query: { enabled: !!address && phase === 'settled' },
  })
  const { data: pendingLoser } = useReadContract({
    address: ADDRESSES.rewardDistributor,
    abi: REWARD_DISTRIBUTOR_ABI,
    functionName: 'pendingLoserRebate',
    args: [gameId, address!],
    query: { enabled: !!address && game.status === STATUS.RESOLVED },
  })
  const { data: pendingWinner } = useReadContract({
    address: ADDRESSES.rewardDistributor,
    abi: REWARD_DISTRIBUTOR_ABI,
    functionName: 'pendingWinnerBonus',
    args: [gameId, address!],
    query: { enabled: !!address && game.status === STATUS.RESOLVED },
  })

  const { writeContract, data: txHash, isPending, error: writeError } = useWriteContract()
  const { isLoading: isConfirming, isSuccess, data: receipt } = useWaitForTransactionReceipt({ hash: txHash })
  const busy = isPending || isConfirming

  // Tracks the pending claim to persist to the API after the tx confirms.
  const pendingClaim = useRef<{ kind: 'pot' | 'rebate' | 'bonus'; amount: bigint } | null>(null)

  // Local claimed flags - flip immediately on tx success so buttons hide at once,
  // without waiting for the on-chain refetch to return updated values.
  const [potClaimed,    setPotClaimed]    = useState(false)
  const [rebateClaimed, setRebateClaimed] = useState(false)
  const [bonusClaimed,  setBonusClaimed]  = useState(false)

  useEffect(() => {
    if (!isSuccess || !receipt) return
    // Hide the claimed button immediately.
    if (pendingClaim.current?.kind === 'pot')    setPotClaimed(true)
    if (pendingClaim.current?.kind === 'rebate') setRebateClaimed(true)
    if (pendingClaim.current?.kind === 'bonus')  setBonusClaimed(true)
    // Refetch game + stake data so the rest of the UI reflects new on-chain state.
    onTxSuccess?.()
    if (!pendingClaim.current || !address) return
    fetch('/api/pod-claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address,
        gameId: gameId.toString(),
        kind:   pendingClaim.current.kind,
        amount: pendingClaim.current.amount.toString(),
        txHash: receipt.transactionHash,
      }),
    }).catch(() => {})
    pendingClaim.current = null
  }, [isSuccess])

  function handleBet(side: number) {
    if (!stakeInput) return
    const stake = parseEther(stakeInput)
    const value = holdsNft ? stake : stake + ENTRY_FEE
    writeContract({
      address: ADDRESSES.betPool,
      abi: BET_POOL_ABI,
      functionName: 'bet',
      args: [gameId, side],
      value,
    })
    setChoosingSide(null)
    setStakeInput('')
  }

  function handleSnapshot() {
    writeContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'snapshot', args: [gameId] })
  }

  function handleExpireMissedSnapshot() {
    writeContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'expireMissedSnapshot', args: [gameId] })
  }

  function handleResolve() {
    writeContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'resolve', args: [gameId] })
  }

  function handleClaim() {
    const amount = game.status === STATUS.RESOLVED
      ? myWinStake + winProfit
      : userLongStake + userShortStake
    pendingClaim.current = { kind: 'pot', amount }
    writeContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'claim', args: [gameId] })
  }

  function handleClaimRebate() {
    pendingClaim.current = { kind: 'rebate', amount: pendingLoser ?? 0n }
    writeContract({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'claimLoserRebate', args: [gameId] })
  }

  function handleClaimBonus() {
    pendingClaim.current = { kind: 'bonus', amount: pendingWinner ?? 0n }
    writeContract({ address: ADDRESSES.rewardDistributor, abi: REWARD_DISTRIBUTOR_ABI, functionName: 'claimWinnerBonus', args: [gameId] })
  }

  const total        = game.totalLongStake + game.totalShortStake
  const userHasLong  = userLongStake  > 0n
  const userHasShort = userShortStake > 0n
  const userHasAny   = userHasLong || userHasShort

  // P&L for resolved games - computed from props, no extra RPC calls needed.
  const winSide     = game.winningSide  // 0 = LONG, 1 = SHORT
  const myWinStake  = winSide === SIDE.LONG ? userLongStake  : userShortStake
  const myLoseStake = winSide === SIDE.LONG ? userShortStake : userLongStake
  let winProfit = 0n
  if (game.status === STATUS.RESOLVED && myWinStake > 0n) {
    const winTotal   = winSide === SIDE.LONG ? game.totalLongStake  : game.totalShortStake
    const loseTotal  = winSide === SIDE.LONG ? game.totalShortStake : game.totalLongStake
    winProfit = myWinStake * (loseTotal - game.feeCollected) / winTotal
  }

  // ── Status badge ─────────────────────────────────────────────────────────

  let badgeText = ''
  let badgeClass = ''
  if (phase === 'betting') {
    badgeText = 'LIVE'; badgeClass = 'text-accent border-accent/40 bg-accent/10'
  } else if (phase === 'snapshot-window') {
    badgeText = 'CLOSING'; badgeClass = 'text-yellow-400 border-yellow-400/40 bg-yellow-400/10'
  } else if (phase === 'snapshot-missed') {
    badgeText = 'INVALID'; badgeClass = 'text-red-400 border-red-400/40 bg-red-400/10'
  } else if (phase === 'hold' || phase === 'resolution-window') {
    badgeText = 'HOLDING'; badgeClass = 'text-muted border-border'
  } else if (game.status === STATUS.RESOLVED) {
    badgeText = game.winningSide === SIDE.LONG ? '↑ LONG WON' : '↓ SHORT WON'
    badgeClass = game.winningSide === SIDE.LONG ? 'text-over border-over/40' : 'text-under border-under/40'
  } else if (game.status === STATUS.REFUNDED) {
    badgeText = 'REFUNDED'; badgeClass = 'text-muted border-border'
  } else {
    badgeText = 'EXPIRED'; badgeClass = 'text-muted border-border'
  }

  return (
    <div className="border border-border rounded-xl p-5 bg-card flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted font-mono">Game #{gameId.toString()}</span>
          <GameRulesButton />
        </div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${badgeClass}`}>
          {badgeText}
        </span>
      </div>

      {/* Timing */}
      {phase === 'betting' && (
        <p className="text-sm text-muted -mt-2">Betting closes in <span className="text-white font-medium">{formatCountdown(bettingLeft)}</span></p>
      )}
      {phase === 'snapshot-missed' && (
        <p className="text-sm text-red-400 -mt-2">
          Snapshot window missed - entry price was never locked. Anyone can expire this game and trigger a full refund.
        </p>
      )}
      {(phase === 'hold' || phase === 'resolution-window') && (
        <p className="text-sm text-muted -mt-2">
          Entry price: <span className="text-white font-medium font-mono">{formatPrice(game.snapshotPrice)}</span>
          {phase === 'hold' && resolutionLeft > 0n && (
            <> · Resolves in <span className="text-white font-medium">{formatCountdown(resolutionLeft)}</span></>
          )}
        </p>
      )}

      {/* Block timeline - open / close / resolve */}
      {phase !== 'settled' && (() => {
        const milestones = [
          { label: 'open',    block: openBlock,  active: false },
          { label: 'close',   block: closeBlock, active: phase === 'betting' || phase === 'snapshot-window' },
          { label: 'resolve', block: resBlock,   active: phase === 'hold' || phase === 'resolution-window' },
        ] as const
        return (
          <div className="flex gap-4 -mt-2 flex-wrap">
            {milestones.map(({ label, block, active }) => {
              const past = currentBlock >= block
              const url  = explorerBlockUrl(block, chainId)
              const num  = `#${block.toLocaleString()}`
              return (
                <span key={label} className="flex items-baseline gap-1 text-xs font-mono">
                  <span className="text-muted/60">{label}</span>
                  {url ? (
                    <a
                      href={url} target="_blank" rel="noopener noreferrer"
                      className={`transition-colors hover:text-accent ${
                        active ? 'text-white' : past ? 'text-muted/40' : 'text-muted'
                      }`}
                    >{num}</a>
                  ) : (
                    <span className={active ? 'text-white' : past ? 'text-muted/40' : 'text-muted'}>{num}</span>
                  )}
                </span>
              )
            })}
          </div>
        )
      })()}
      {game.status === STATUS.RESOLVED && (
        <p className="text-sm text-muted -mt-2 font-mono">
          <span className="text-muted">Entry</span>{' '}
          <span className="text-white">{formatPrice(game.snapshotPrice)}</span>
          {gameTxs.snapshotTx && (
            <a href={explorerTxUrl(gameTxs.snapshotTx, chainId)} target="_blank" rel="noopener noreferrer"
              className="ml-1 text-xs text-muted hover:text-accent transition-colors">↗</a>
          )}
          {' → '}
          <span className="text-muted">End</span>{' '}
          <span className={game.resolvedPrice > game.snapshotPrice ? 'text-over' : 'text-under'}>
            {formatPrice(game.resolvedPrice)}
          </span>
          {gameTxs.resolveTx && (
            <a href={explorerTxUrl(gameTxs.resolveTx, chainId)} target="_blank" rel="noopener noreferrer"
              className="ml-1 text-xs text-muted hover:text-accent transition-colors">↗</a>
          )}
        </p>
      )}

      {/* Stakes */}
      <div className="flex items-center gap-3 text-sm">
        <div className="flex-1 text-center">
          <p className="text-xs text-over mb-0.5">↑ LONG</p>
          <p className="font-semibold text-over">{formatRon(game.totalLongStake)}</p>
        </div>
        <div className="flex-1 text-center">
          <p className="text-xs text-muted mb-0.5">Total</p>
          <p className="font-semibold">{formatRon(total)}</p>
        </div>
        <div className="flex-1 text-center">
          <p className="text-xs text-under mb-0.5">↓ SHORT</p>
          <p className="font-semibold text-under">{formatRon(game.totalShortStake)}</p>
        </div>
      </div>
      <PotBar long={game.totalLongStake} short={game.totalShortStake} />

      {/* User position */}
      {userHasAny && phase !== 'settled' && (
        <div className="text-xs text-muted border-t border-border pt-3 -mb-1">
          Your stake:
          {userHasLong  && <span className="ml-2 text-over">↑ {formatRon(userLongStake)}</span>}
          {userHasShort && <span className="ml-2 text-under">↓ {formatRon(userShortStake)}</span>}
        </div>
      )}

      {/* User result - only for settled games with a position */}
      {userHasAny && phase === 'settled' && (
        <div className="border border-border/60 rounded-xl px-4 py-3 bg-bg flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted uppercase tracking-widest">Your result</p>

          {game.status === STATUS.RESOLVED && (
            <>
              {myWinStake > 0n && (
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-over font-medium">
                    {winSide === SIDE.LONG ? '↑ LONG' : '↓ SHORT'} won
                  </span>
                  <span className="text-muted text-xs">
                    Staked {formatRon(myWinStake)}
                    {' · '}
                    <span className="text-over font-semibold">+{formatRon(winProfit)}</span>
                  </span>
                </div>
              )}
              {myLoseStake > 0n && (
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-under font-medium">
                    {winSide === SIDE.LONG ? '↓ SHORT' : '↑ LONG'} lost
                  </span>
                  <span className="text-muted text-xs">
                    Staked {formatRon(myLoseStake)}
                    {' · '}
                    <span className="text-under font-semibold">−{formatRon(myLoseStake)}</span>
                  </span>
                </div>
              )}
            </>
          )}

          {(game.status === STATUS.REFUNDED || game.status === STATUS.EXPIRED) && (
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted">
                {game.status === STATUS.REFUNDED ? 'Refunded' : 'Expired - refund available'}
              </span>
              <span className="font-semibold">{formatRon(userLongStake + userShortStake)}</span>
            </div>
          )}

          {/* PoD amounts */}
          {(pendingLoser ?? 0n) > 0n && (
            <div className="flex items-center justify-between text-sm pt-1 border-t border-border/40">
              <span className="text-purple-400">PoD rebate</span>
              <span className="text-purple-400 font-semibold">+{formatRon(pendingLoser!)}</span>
            </div>
          )}
          {(pendingWinner ?? 0n) > 0n && (
            <div className="flex items-center justify-between text-sm pt-1 border-t border-border/40">
              <span className="text-purple-400">PoD bonus</span>
              <span className="text-purple-400 font-semibold">+{formatRon(pendingWinner!)}</span>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {/* Bet form */}
        {phase === 'betting' && address && (
          choosingSide === null ? (
            <>
              <button
                onClick={() => setChoosingSide(SIDE.LONG)}
                className="flex-1 py-2 rounded-lg bg-over/15 border border-over/30 text-over text-sm font-medium hover:bg-over/25 transition-colors"
              >
                ↑ Long
              </button>
              <button
                onClick={() => setChoosingSide(SIDE.SHORT)}
                className="flex-1 py-2 rounded-lg bg-under/15 border border-under/30 text-under text-sm font-medium hover:bg-under/25 transition-colors"
              >
                ↓ Short
              </button>
            </>
          ) : (
            <div className="flex flex-col gap-1 w-full">
              <div className="flex gap-2">
                <input
                  type="number" min="1" step="0.1" placeholder="Amount (RON)"
                  value={stakeInput}
                  onChange={e => setStakeInput(e.target.value)}
                  className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button
                  disabled={busy || !stakeInput || parseFloat(stakeInput) <= 0}
                  onClick={() => handleBet(choosingSide)}
                  className={`px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors ${
                    choosingSide === SIDE.LONG ? 'bg-over text-black' : 'bg-under text-white'
                  }`}
                >
                  {busy ? '…' : choosingSide === SIDE.LONG ? '↑ Long' : '↓ Short'}
                </button>
                <button onClick={() => { setChoosingSide(null); setStakeInput('') }}
                  className="px-3 py-2 text-muted text-sm hover:text-white">✕</button>
              </div>
              {!holdsNft && stakeInput && parseFloat(stakeInput) > 0 && (
                <p className="text-xs text-yellow-400">
                  +0.1 RON entry fee · total {formatRon(parseEther(stakeInput) + ENTRY_FEE)}
                </p>
              )}
            </div>
          )
        )}

        {/* Snapshot (fallback if keeper missed window) */}
        {phase === 'snapshot-window' && game.snapshotPrice === 0n && (
          <button disabled={busy} onClick={handleSnapshot}
            className="flex-1 py-2 rounded-lg bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 text-sm font-medium hover:bg-yellow-500/25 disabled:opacity-50 transition-colors">
            {busy ? 'Snapshotting…' : 'Snapshot Price'}
          </button>
        )}

        {/* Expire immediately when snapshot window closed with no snapshot */}
        {phase === 'snapshot-missed' && (
          <button disabled={busy} onClick={handleExpireMissedSnapshot}
            className="flex-1 py-2 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/25 disabled:opacity-50 transition-colors">
            {busy ? 'Expiring…' : 'Expire & Refund All'}
          </button>
        )}

        {/* Resolve (fallback if keeper missed window) */}
        {phase === 'resolution-window' && (
          <button disabled={busy} onClick={handleResolve}
            className="flex-1 py-2 rounded-lg bg-accent/15 border border-accent/30 text-accent text-sm font-medium hover:bg-accent/25 disabled:opacity-50 transition-colors">
            {busy ? 'Resolving…' : 'Resolve Game'}
          </button>
        )}

        {/* Claim pot - winners only when resolved; everyone when refunded/expired */}
        {phase === 'settled' && !hasClaimed && !potClaimed && (
          game.status === STATUS.RESOLVED ? myWinStake > 0n : userHasAny
        ) && (
          <button disabled={busy} onClick={handleClaim}
            className="flex-1 py-2 rounded-lg bg-over/15 border border-over/30 text-over text-sm font-medium hover:bg-over/25 disabled:opacity-50 transition-colors">
            {busy ? '…' : 'Claim'}
          </button>
        )}

        {/* PoD claim buttons - non-settled games (shown outside the result box) */}
        {phase !== 'settled' && !rebateClaimed && (pendingLoser ?? 0n) > 0n && (
          <button disabled={busy} onClick={handleClaimRebate}
            className="flex-1 py-2 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors">
            PoD rebate {formatRon(pendingLoser!)}
          </button>
        )}
        {phase !== 'settled' && !bonusClaimed && (pendingWinner ?? 0n) > 0n && (
          <button disabled={busy} onClick={handleClaimBonus}
            className="flex-1 py-2 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors">
            PoD bonus {formatRon(pendingWinner!)}
          </button>
        )}

        {/* PoD claim buttons - settled games (shown alongside the result summary) */}
        {phase === 'settled' && !rebateClaimed && (pendingLoser ?? 0n) > 0n && (
          <button disabled={busy} onClick={handleClaimRebate}
            className="flex-1 py-2 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors">
            {busy ? 'Claiming…' : 'Claim PoD rebate'}
          </button>
        )}
        {phase === 'settled' && !bonusClaimed && (pendingWinner ?? 0n) > 0n && (
          <button disabled={busy} onClick={handleClaimBonus}
            className="flex-1 py-2 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-400 text-sm font-medium hover:bg-purple-500/25 disabled:opacity-50 transition-colors">
            {busy ? 'Claiming…' : 'Claim PoD bonus'}
          </button>
        )}
      </div>

      {writeError && (
        <p className="text-xs text-red-400 px-1 break-all">
          {(writeError as { shortMessage?: string }).shortMessage ?? writeError.message}
        </p>
      )}
    </div>
  )
}
