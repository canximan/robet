'use client'

import { useChainId } from 'wagmi'
import { ADDRESSES, explorerAddressUrl } from '@/lib/contracts'

const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL
const ZERO       = '0x0000000000000000000000000000000000000000'

const CONTRACTS = [
  { label: 'BetPool',   address: ADDRESSES.betPool   },
  { label: 'Staking',   address: ADDRESSES.staking   },
  { label: 'NFT',       address: ADDRESSES.robetNft  },
  { label: 'PriceFeed', address: ADDRESSES.priceFeed },
] as const

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function Footer() {
  const chainId = useChainId()

  return (
    <footer className="border-t border-border">
      <div className="max-w-2xl mx-auto w-full px-4 py-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">

        {CONTRACTS.filter(c => c.address !== ZERO).map(({ label, address }) => (
          <a
            key={label}
            href={explorerAddressUrl(address, chainId)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono hover:text-white transition-colors"
          >
            <span className="font-sans text-muted/50">{label}</span>
            {short(address)}
          </a>
        ))}

        {GITHUB_URL && (
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto hover:text-white transition-colors"
          >
            GitHub ↗
          </a>
        )}

      </div>
    </footer>
  )
}
