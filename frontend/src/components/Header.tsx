'use client'

import { useState } from 'react'
import { useAccount, useConnect, useDisconnect, useReadContract, useBlockNumber, useSwitchChain } from 'wagmi'
import { ADDRESSES, ROBET_NFT_ABI, PRICE_FEED_ABI, formatPrice } from '@/lib/contracts'
import { targetChain, roninConnector, metaMaskConnector } from '@/lib/wagmi'

// ── Wallet picker modal ────────────────────────────────────────────────────────

const WALLET_OPTIONS = [
  {
    id:         'ronin' as const,
    name:       'Ronin Wallet',
    detail:     'Official Sky Mavis wallet',
    connector:  roninConnector,
    installUrl: 'https://wallet.roninchain.com',
    // Check for Ronin's dedicated provider (not window.ethereum).
    isInstalled: () => typeof window !== 'undefined' && !!(window as any).ronin?.provider,
    // Icon: Ronin brand blue with "R"
    icon: (
      <div className="w-10 h-10 rounded-xl bg-[#1273EA] flex items-center justify-center shrink-0">
        <span className="text-white font-bold text-base leading-none">R</span>
      </div>
    ),
  },
  {
    id:         'metamask' as const,
    name:       'MetaMask',
    detail:     'Browser extension wallet',
    connector:  metaMaskConnector,
    installUrl: 'https://metamask.io/download',
    // isMetaMask=true on window.ethereum distinguishes MetaMask from Ronin Wallet,
    // which does NOT set that flag when it injects into window.ethereum.
    isInstalled: () => typeof window !== 'undefined' && !!(window as any).ethereum?.isMetaMask,
    // Icon: MetaMask orange with fox emoji
    icon: (
      <div className="w-10 h-10 rounded-xl bg-[#F6851B] flex items-center justify-center shrink-0 text-xl leading-none">
        🦊
      </div>
    ),
  },
]

function WalletPicker({ onClose }: { onClose: () => void }) {
  const { connect, isPending } = useConnect()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl p-6 w-80 flex flex-col gap-4 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Connect Wallet</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-white transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Wallet options */}
        <div className="flex flex-col gap-2">
          {WALLET_OPTIONS.map(opt => {
            const installed = opt.isInstalled()
            return (
              <button
                key={opt.id}
                disabled={isPending}
                onClick={() => {
                  if (installed) {
                    connect({ connector: opt.connector })
                    onClose()
                  } else {
                    window.open(opt.installUrl, '_blank', 'noopener,noreferrer')
                  }
                }}
                className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left transition-colors disabled:cursor-wait ${
                  installed
                    ? 'border-border hover:border-accent/60 hover:bg-accent/5'
                    : 'border-border/40 opacity-50'
                }`}
              >
                {opt.icon}
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-white">{opt.name}</span>
                  <span className="text-xs text-muted">
                    {installed ? opt.detail : 'Not installed - click to install'}
                  </span>
                </div>
                {/* External link arrow for not-installed wallets */}
                {!installed && (
                  <span className="ml-auto text-xs text-muted shrink-0">↗</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Header ─────────────────────────────────────────────────────────────────────

export function Header() {
  const { address, isConnected, chainId } = useAccount()
  const { disconnect } = useDisconnect()
  const { data: blockNumber } = useBlockNumber({ watch: true })
  const [showPicker, setShowPicker] = useState(false)

  const { data: price } = useReadContract({
    address: ADDRESSES.priceFeed,
    abi: PRICE_FEED_ABI,
    functionName: 'ronPriceUsd1e18',
    chainId: targetChain.id,
    query: { refetchInterval: 15_000 },
  })

  const { data: nftBalance } = useReadContract({
    address: ADDRESSES.robetNft,
    abi: ROBET_NFT_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  })
  const holdsNft = nftBalance !== undefined && nftBalance > 0n

  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const wrongChain = isConnected && chainId !== targetChain.id

  return (
    <>
      <header className="border-b border-border px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <span className="text-lg font-bold tracking-tight">Robet</span>
          {price != null && (
            <span className="text-sm text-muted">
              RON <span className="text-white font-mono">{formatPrice(price)}</span>
            </span>
          )}
          {blockNumber != null && (
            <span className="text-xs text-muted font-mono">#{blockNumber.toLocaleString()}</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {isConnected && !wrongChain && (
            <>
              {nftBalance !== undefined && (
                <span className={`text-xs border rounded px-2 py-1 ${
                  holdsNft
                    ? 'text-over border-over/30'
                    : 'text-yellow-400 border-yellow-400/30'
                }`}>
                  {holdsNft ? 'NFT holder' : 'No NFT'}
                </span>
              )}
            </>
          )}

          {wrongChain && (
            <button
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: targetChain.id })}
              className="px-4 py-2 rounded bg-red-500/20 border border-red-500/40 text-red-400 text-sm font-medium hover:bg-red-500/30 disabled:opacity-50 transition-colors"
            >
              {isSwitching ? 'Switching…' : `Switch to ${targetChain.name}`}
            </button>
          )}

          {isConnected ? (
            <button
              onClick={() => disconnect()}
              className="px-3 py-2 rounded border border-border text-sm text-muted hover:text-white transition-colors"
            >
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </button>
          ) : (
            <button
              onClick={() => setShowPicker(true)}
              className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {showPicker && <WalletPicker onClose={() => setShowPicker(false)} />}
    </>
  )
}
