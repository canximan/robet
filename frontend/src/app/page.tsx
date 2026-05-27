'use client'

import { useEffect, useState } from 'react'
import { useAccount, useBlockNumber, useReadContract, useReadContracts } from 'wagmi'
import { ADDRESSES, BET_POOL_ABI, STATUS, SIDE } from '@/lib/contracts'
import { Header }       from '@/components/Header'
import { Footer }       from '@/components/Footer'
import { GameCard }     from '@/components/GameCard'
import { RewardsPanel } from '@/components/RewardsPanel'
import { NftPanel }     from '@/components/NftPanel'
import { StakingPanel } from '@/components/StakingPanel'

type Tab = 'active' | 'history' | 'my' | 'stake' | 'nft' | 'pod'

const TABS: { id: Tab; label: string }[] = [
  { id: 'stake',   label: '💎 Stake' },
  { id: 'active',  label: 'Active'   },
  { id: 'history', label: 'History'  },
  { id: 'my',      label: 'My Games' },
  { id: 'nft',     label: '🎟 NFT'   },
  { id: 'pod',     label: '🎁 PoD'   },
]

const TAB_STORAGE_KEY = 'robet:tab'
const TAB_IDS = TABS.map(t => t.id)

export default function Home() {
  const { address }          = useAccount()
  const [tab, setTab]            = useState<Tab>('stake')
  // Restore the last-used tab from localStorage on mount. Writes happen in
  // selectTab() below (called from the click handler) so there's no effect
  // race that could overwrite the saved value with the initial 'active'.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY)
      if (saved && (TAB_IDS as string[]).includes(saved)) setTab(saved as Tab)
    } catch {}
  }, [])
  function selectTab(next: Tab) {
    setTab(next)
    try { localStorage.setItem(TAB_STORAGE_KEY, next) } catch {}
  }
  const [hideEmpty, setHideEmpty] = useState(true)
  const { data: blockNumber } = useBlockNumber({ watch: true })
  const currentBlock          = blockNumber ?? 0n

  // ── Contract constants ────────────────────────────────────────────────────

  const { data: genesisBlock }    = useReadContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'GENESIS_BLOCK' })
  const { data: bettingBlocksRaw } = useReadContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'BETTING_BLOCKS' })
  const { data: holdBlocksRaw }    = useReadContract({ address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'HOLD_BLOCKS' })

  const genesis       = genesisBlock    ?? 0n
  const bettingBlocks = bettingBlocksRaw ?? 1_200n
  const holdBlocks    = holdBlocksRaw    ?? 1_200n

  // ── Game enumeration ──────────────────────────────────────────────────────

  const { data: currentGameId, isLoading: isLoadingGameId } = useReadContract({
    address: ADDRESSES.betPool, abi: BET_POOL_ABI, functionName: 'currentGameId',
    query: { refetchInterval: 10_000 },
  })
  const gameCount = Number(currentGameId ?? 0n) + 1  // inclusive: games 0..currentGameId
  const gameIds   = Array.from({ length: gameCount }, (_, i) => BigInt(i))

  // Batch-read all game structs.
  const { data: gamesRaw, isLoading: isLoadingGames, refetch: refetchGames } = useReadContracts({
    contracts: gameIds.map(id => ({
      address: ADDRESSES.betPool,
      abi: BET_POOL_ABI,
      functionName: 'getGame' as const,
      args: [id] as const,
    })),
    query: { enabled: gameCount > 0, refetchInterval: 10_000 },
  })

  // ── User stake lookup (for My Games filter) ───────────────────────────────

  const { data: userLongRaw, refetch: refetchLong } = useReadContracts({
    contracts: gameIds.map(id => ({
      address: ADDRESSES.betPool,
      abi: BET_POOL_ABI,
      functionName: 'userStake' as const,
      args: [id, address!, BigInt(SIDE.LONG)] as const,
    })),
    query: { enabled: !!address && gameCount > 0 },
  })
  const { data: userShortRaw, refetch: refetchShort } = useReadContracts({
    contracts: gameIds.map(id => ({
      address: ADDRESSES.betPool,
      abi: BET_POOL_ABI,
      functionName: 'userStake' as const,
      args: [id, address!, BigInt(SIDE.SHORT)] as const,
    })),
    query: { enabled: !!address && gameCount > 0 },
  })

  function refetchAll() {
    refetchGames()
    refetchLong()
    refetchShort()
  }

  // ── Normalise ─────────────────────────────────────────────────────────────

  type GameEntry = {
    gameId: bigint
    game: {
      snapshotPrice: bigint
      resolvedPrice: bigint
      totalLongStake: bigint
      totalShortStake: bigint
      feeCollected: bigint
      status: number
      winningSide: number
    }
    userLong:  bigint
    userShort: bigint
  }

  const entries: GameEntry[] = gameIds
    .map((gameId, i) => {
      const raw = gamesRaw?.[i]
      if (raw?.status !== 'success') return null
      return {
        gameId,
        game: raw.result as GameEntry['game'],
        userLong:  (userLongRaw?.[i]?.result  ?? 0n) as bigint,
        userShort: (userShortRaw?.[i]?.result ?? 0n) as bigint,
      }
    })
    .filter(Boolean) as GameEntry[]

  // True only on the very first fetch - subsequent refetches keep existing data visible.
  const isInitialLoad = isLoadingGameId || (isLoadingGames && gamesRaw === undefined)

  // ── Derived lists ─────────────────────────────────────────────────────────

  // Active: current game (last) + previous game if not settled
  const activeIds = currentGameId != null
    ? [currentGameId, ...(currentGameId > 0n ? [currentGameId - 1n] : [])]
    : []

  const activeEntries = activeIds
    .map(id => entries.find(e => e.gameId === id))
    .filter(Boolean) as GameEntry[]

  // History: all games except the current, newest first
  const historyEntries = [...entries]
    .filter(e => e.gameId !== currentGameId)
    .reverse()

  // My Games: games the user staked on
  const myEntries = entries.filter(e => e.userLong > 0n || e.userShort > 0n)

  // ── Render ────────────────────────────────────────────────────────────────

  const counts: Partial<Record<Tab, number>> = {
    history: historyEntries.length,
    my:      myEntries.length,
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 flex flex-col gap-6">
        {/* Tabs */}
        <div className="flex gap-1 border-b border-border overflow-x-auto scrollbar-none">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={`shrink-0 px-4 py-2.5 text-sm font-medium transition-colors relative ${
                tab === t.id
                  ? 'text-white after:absolute after:bottom-0 after:inset-x-0 after:h-0.5 after:bg-accent'
                  : 'text-muted hover:text-white'
              }`}
            >
              {t.label}
              {counts[t.id] != null && (counts[t.id] as number) > 0 && (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.id ? 'bg-accent/20 text-accent' : 'bg-border text-muted'
                }`}>
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Staking tab */}
        {tab === 'stake' && <StakingPanel />}

        {/* NFT tab */}
        {tab === 'nft' && <NftPanel />}

        {/* PoD tab (BetPool + Staking) */}
        {tab === 'pod' && <RewardsPanel />}

        {/* Active tab */}
        {tab === 'active' && (
          isInitialLoad ? (
            <div className="flex flex-col gap-4">
              {[0, 1].map(i => (
                <div key={i} className="rounded-xl border border-border bg-card p-5 animate-pulse">
                  <div className="h-4 w-24 bg-border rounded mb-4" />
                  <div className="h-8 w-32 bg-border rounded mb-6" />
                  <div className="flex gap-3">
                    <div className="h-10 flex-1 bg-border rounded-lg" />
                    <div className="h-10 flex-1 bg-border rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : activeEntries.length === 0 ? (
            <div className="text-center py-20 text-muted">
              <p className="text-4xl mb-3">📊</p>
              <p className="font-medium">No active game yet.</p>
              <p className="text-sm mt-1">Games start automatically once the contract is deployed.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {activeEntries.map(e => (
                <GameCard
                  key={e.gameId.toString()}
                  gameId={e.gameId}
                  game={e.game}
                  genesisBlock={genesis}
                  bettingBlocks={bettingBlocks}
                  holdBlocks={holdBlocks}
                  currentBlock={currentBlock}
                  userLongStake={e.userLong}
                  userShortStake={e.userShort}
                  onTxSuccess={refetchAll}
                />
              ))}
            </div>
          )
        )}

        {/* History tab */}
        {tab === 'history' && (
          historyEntries.length === 0 ? (
            <div className="text-center py-20 text-muted">
              <p className="font-medium">No completed games yet.</p>
            </div>
          ) : (() => {
            // "Empty" = no winner determined: REFUNDED (tie), EXPIRED (snapshot
            // missed and finalised), or INVALID (still OPEN but past the
            // snapshot window with snapshotPrice == 0 — should be expired).
            const SNAPSHOT_WINDOW = 10n
            function isEmpty(e: typeof historyEntries[number]): boolean {
              if (e.game.status === STATUS.REFUNDED) return true
              if (e.game.status === STATUS.EXPIRED)  return true
              if (e.game.status === STATUS.OPEN && e.game.snapshotPrice === 0n) {
                const closeBlock  = genesis + (e.gameId + 1n) * bettingBlocks
                const snapshotEnd = closeBlock + SNAPSHOT_WINDOW
                if (currentBlock >= snapshotEnd) return true
              }
              return false
            }

            const visibleHistory = hideEmpty
              ? historyEntries.filter(e => !isEmpty(e))
              : historyEntries
            const emptyCount = historyEntries.length - visibleHistory.length
            return (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-end">
                  <button
                    onClick={() => setHideEmpty(v => !v)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      hideEmpty
                        ? 'border-border text-muted hover:text-white hover:border-accent'
                        : 'border-accent/40 text-accent bg-accent/10 hover:bg-accent/20'
                    }`}
                    title="Refunded · Expired · Invalid (no winner)"
                  >
                    {hideEmpty
                      ? `Show empty (${emptyCount})`
                      : 'Hide empty'}
                  </button>
                </div>
                {visibleHistory.length === 0 ? (
                  <div className="text-center py-16 text-muted">
                    <p className="font-medium">All games are empty.</p>
                    <p className="text-sm mt-1">Refunded, expired, or never snapshot-ed — toggle the filter above to show them.</p>
                  </div>
                ) : (
                  visibleHistory.map(e => (
                    <GameCard
                      key={e.gameId.toString()}
                      gameId={e.gameId}
                      game={e.game}
                      genesisBlock={genesis}
                  bettingBlocks={bettingBlocks}
                  holdBlocks={holdBlocks}
                      currentBlock={currentBlock}
                      userLongStake={e.userLong}
                      userShortStake={e.userShort}
                    />
                  ))
                )}
              </div>
            )
          })()
        )}

        {/* My Games tab */}
        {tab === 'my' && (
          !address ? (
            <div className="text-center py-20 text-muted">
              <p className="text-4xl mb-3">👛</p>
              <p className="font-medium">Connect your wallet to see your games.</p>
            </div>
          ) : myEntries.length === 0 ? (
            <div className="text-center py-20 text-muted">
              <p className="font-medium">You haven't placed any bets yet.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {[...myEntries].reverse().map(e => (
                <GameCard
                  key={e.gameId.toString()}
                  gameId={e.gameId}
                  game={e.game}
                  genesisBlock={genesis}
                  bettingBlocks={bettingBlocks}
                  holdBlocks={holdBlocks}
                  currentBlock={currentBlock}
                  userLongStake={e.userLong}
                  userShortStake={e.userShort}
                  onTxSuccess={refetchAll}
                />
              ))}
            </div>
          )
        )}
      </main>
      <Footer />
    </div>
  )
}
