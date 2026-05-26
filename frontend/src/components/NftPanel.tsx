'use client'

import { useAccount, useReadContract } from 'wagmi'
import { ADDRESSES, ROBET_NFT_ABI } from '@/lib/contracts'

export function NftPanel() {
  const { address } = useAccount()

  const { data: balance } = useReadContract({
    address: ADDRESSES.robetNft,
    abi: ROBET_NFT_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  })

  const holdsNft = balance !== undefined && balance > 0n

  return (
    <div className="flex flex-col gap-6">

      {/* NFT card */}
      <div className="relative border border-border rounded-2xl overflow-hidden bg-card">
        {/* Artwork placeholder */}
        <div className="h-48 bg-gradient-to-br from-accent/20 via-indigo-900/30 to-border/20 flex items-center justify-center select-none">
          <span className="text-7xl opacity-80">🎟</span>
        </div>

        {/* Info */}
        <div className="p-5 flex flex-col gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">Robet NFT</h2>
            <p className="text-sm text-muted mt-1">
              Up to 33,000 NFTs, distributed over ~33 years via the Staking dice-roll lottery (halving each year).
              Holders bet without the <span className="text-white font-medium">0.1 RON entry fee</span> on every game.
            </p>
          </div>

          {/* Perks */}
          <div className="flex flex-col gap-1.5 text-sm">
            <div className="flex items-center gap-2 text-over">
              <span>✓</span>
              <span>Fee-free betting - save 0.1 RON per game</span>
            </div>
          </div>
        </div>
      </div>

      {/* User status */}
      {!address ? (
        <div className="text-center py-6 text-muted text-sm">
          Connect your wallet to check your NFT balance.
        </div>
      ) : balance === undefined ? (
        /* loading */
        <div className="h-12 rounded-xl bg-card border border-border animate-pulse" />
      ) : holdsNft ? (
        <div className="flex items-center gap-3 border border-over/30 bg-over/5 rounded-xl px-4 py-3">
          <span className="text-2xl">✅</span>
          <div>
            <p className="text-sm font-semibold text-over">You hold {balance.toString()} Robet NFT{balance > 1n ? 's' : ''}</p>
            <p className="text-xs text-muted mt-0.5">Entry fee is waived on all your bets.</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 border border-yellow-500/30 bg-yellow-500/5 rounded-xl px-4 py-3">
          <span className="text-2xl">🎟</span>
          <div>
            <p className="text-sm font-semibold text-yellow-300">You don&apos;t hold a Robet NFT</p>
            <p className="text-xs text-muted mt-0.5">Stake in the Staking tab to roll for one - or pay the 0.1 RON entry fee per bet.</p>
          </div>
        </div>
      )}

      {/* How to earn */}
      <div className="border border-border rounded-xl px-5 py-4 flex flex-col gap-2 bg-card">
        <p className="text-xs font-semibold text-muted uppercase tracking-widest">How to earn one</p>
        <p className="text-sm text-white font-medium">Stake RON, wait 1 day, roll the dice.</p>
        <p className="text-xs text-muted">Total supply is capped at 33,000. New NFTs are only minted through the Staking lottery, with the mint rate halving each year.</p>
      </div>

    </div>
  )
}
