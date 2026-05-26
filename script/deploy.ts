/**
 * deploy.ts - runs forge script and patches the root .env with the new addresses.
 *
 * Usage: npm run deploy [-- --chain saigon|mainnet]
 *
 * After forge broadcasts, it writes broadcast/Deploy.s.sol/<chainId>/run-latest.json.
 * We read contractName → contractAddress from that file and update ../.env.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT     = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')

// Parse the .env file into key→value pairs.
function readEnv(): Map<string, string> {
  const map = new Map<string, string>()
  if (!fs.existsSync(ENV_FILE)) return map
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

// Write the map back, preserving comments and blank lines.
function writeEnv(updates: Record<string, string>) {
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n')
  const patched = lines.map(line => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    if (m && updates[m[1]] !== undefined) return `${m[1]}=${updates[m[1]]}`
    return line
  })
  fs.writeFileSync(ENV_FILE, patched.join('\n'))
}

// Determine RPC URL and chain ID from env / CLI args.
const args     = process.argv.slice(2)
const chainArg = args[args.indexOf('--chain') + 1] ?? 'local'

const env      = readEnv()
const chainId  = chainArg === 'mainnet' ? '2020' : chainArg === 'saigon' ? '2021' : '31337'
const rpcUrl   = chainArg === 'mainnet'
  ? (env.get('RONIN_RPC_URL')  ?? 'https://api.roninchain.com/rpc')
  : chainArg === 'saigon'
  ? (env.get('SAIGON_RPC_URL') ?? 'https://saigon-testnet.roninchain.com/rpc')
  : (env.get('RONIN_RPC_URL')  ?? 'http://127.0.0.1:8545')

// Run forge script.
console.log(`\nDeploying to chain ${chainId} via ${rpcUrl} …\n`)
try {
  execSync(
    `forge script script/Deploy.s.sol:Deploy --rpc-url ${rpcUrl} --broadcast --slow`,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RONIN_RPC_URL: rpcUrl } }
  )
} catch {
  process.exit(1)
}

// Read broadcast artifacts.
const broadcastFile = path.join(
  ROOT, 'broadcast', 'Deploy.s.sol', chainId, 'run-latest.json'
)
if (!fs.existsSync(broadcastFile)) {
  console.error(`Broadcast file not found: ${broadcastFile}`)
  process.exit(1)
}

const broadcast = JSON.parse(fs.readFileSync(broadcastFile, 'utf8'))

// Map contractName → contractAddress from the transactions list.
const addrs: Record<string, string> = {}
for (const tx of broadcast.transactions ?? []) {
  if (tx.transactionType === 'CREATE' && tx.contractName && tx.contractAddress) {
    addrs[tx.contractName] = tx.contractAddress
  }
}

// RobetNFT and Staking are plain (non-upgradeable) contracts now.
// BetPool is still proxied - its name in broadcast is BetPoolProxy.
// PriceFeed / MockPriceFeed are plain contracts looked up by name.
const nft     = addrs['RobetNFT']
const feed    = addrs['PriceFeed'] ?? addrs['MockPriceFeed']
const pool    = addrs['BetPoolProxy']
const staking = addrs['Staking']

if (!nft || !feed || !pool || !staking) {
  console.error('Could not find all contract addresses in broadcast output:')
  console.error(addrs)
  process.exit(1)
}

const treasury = env.get('TREASURY_ADDRESS') ?? ''

// Patch root .env.
writeEnv({
  ROBET_NFT_ADDRESS:       nft,
  PRICE_FEED_ADDRESS:      feed,
  BET_POOL_ADDRESS:        pool,
  STAKING_ADDRESS:         staking,
  NEXT_PUBLIC_ROBET_NFT:   nft,
  NEXT_PUBLIC_PRICE_FEED:  feed,
  NEXT_PUBLIC_BET_POOL:    pool,
  NEXT_PUBLIC_STAKING:     staking,
  ...(treasury ? { NEXT_PUBLIC_TREASURY_WALLET: treasury } : {}),
})

console.log('\n.env patched:')
console.log(`  ROBET_NFT_ADDRESS  = ${nft}`)
console.log(`  PRICE_FEED_ADDRESS = ${feed}`)
console.log(`  BET_POOL_ADDRESS   = ${pool}`)
console.log(`  STAKING_ADDRESS    = ${staking}`)
