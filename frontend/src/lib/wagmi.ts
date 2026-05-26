import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { defineChain } from 'viem'

export const ronin = defineChain({
  id: 2020,
  name: 'Ronin',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://api.roninchain.com/rpc'] },
  },
  blockExplorers: {
    default: { name: 'Ronin Explorer', url: 'https://explorer.roninchain.com' },
  },
})

export const saigon = defineChain({
  id: 2021,
  name: 'Saigon Testnet',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://saigon-testnet.roninchain.com/rpc'] },
  },
  blockExplorers: {
    default: { name: 'Saigon Explorer', url: 'https://saigon-app.roninchain.com' },
  },
})

// Foundry's `anvil` local chain - chainId 31337, mock RON as the native currency.
export const local = defineChain({
  id: 31337,
  name: 'Anvil (Local)',
  nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
  },
})

// The single chain this deployment targets.
// All contract reads and the "wrong network" check use this.
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337)
export const targetChain = [ronin, saigon, local].find(c => c.id === chainId) ?? local

// Ronin Wallet browser extension injects its EIP-1193 provider at window.ronin.provider
// (separate from window.ethereum, which it does not claim as its own).
export const roninConnector = injected({
  target() {
    return {
      id:       'roninWallet',
      name:     'Ronin Wallet',
      provider: typeof window !== 'undefined' ? (window as any).ronin?.provider : undefined,
    }
  },
})

// MetaMask and compatible extensions that inject into window.ethereum with isMetaMask=true.
export const metaMaskConnector = injected({ target: 'metaMask' })

export const config = createConfig({
  chains: [ronin, saigon, local],
  connectors: [roninConnector, metaMaskConnector],
  transports: {
    [ronin.id]:   http(),
    [saigon.id]:  http(),
    [local.id]:   http(),
  },
})
