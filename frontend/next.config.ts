import type { NextConfig } from 'next'
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

// Load the single root .env before Next.js processes NEXT_PUBLIC_ vars.
// Shell environment variables always take precedence (override: false).
loadEnv({ path: resolve(process.cwd(), '.env'), override: false })

// Explicitly forward NEXT_PUBLIC_* into the env config so Next.js bakes them
// into client bundles regardless of its own env-file pipeline.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_CHAIN_ID:        process.env.NEXT_PUBLIC_CHAIN_ID        ?? '2020',
    NEXT_PUBLIC_ROBET_NFT:       process.env.NEXT_PUBLIC_ROBET_NFT       ?? '',
    NEXT_PUBLIC_PRICE_FEED:      process.env.NEXT_PUBLIC_PRICE_FEED      ?? '',
    NEXT_PUBLIC_BET_POOL:        process.env.NEXT_PUBLIC_BET_POOL        ?? '',
    NEXT_PUBLIC_STAKING:         process.env.NEXT_PUBLIC_STAKING         ?? '',
    NEXT_PUBLIC_TREASURY_WALLET: process.env.NEXT_PUBLIC_TREASURY_WALLET ?? '',
    NEXT_PUBLIC_GITHUB_URL:      process.env.NEXT_PUBLIC_GITHUB_URL      ?? '',
  },
}

export default nextConfig
