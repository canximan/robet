/**
 * deploy-staking.ts - runs `forge script DeployStaking` and auto-patches the
 * root .env with STAKING_ADDRESS / NEXT_PUBLIC_STAKING.
 *
 * Usage: npm run deploy:staking [-- --chain saigon|mainnet]
 *
 * Note: after this completes, the OWNER (cold wallet) must run one more tx:
 *   cast send $ROBET_NFT_ADDRESS "setMinter(address)" $STAKING_ADDRESS \
 *     --private-key <OWNER_KEY> --rpc-url <RPC>
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT     = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')

function readEnv(): Map<string, string> {
  const map = new Map<string, string>()
  if (!fs.existsSync(ENV_FILE)) return map
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

function writeEnv(updates: Record<string, string>) {
  const lines   = fs.readFileSync(ENV_FILE, 'utf8').split('\n')
  const patched = lines.map(line => {
    const m = line.match(/^([A-Z0-9_]+)=/)
    if (m && updates[m[1]] !== undefined) return `${m[1]}=${updates[m[1]]}`
    return line
  })
  fs.writeFileSync(ENV_FILE, patched.join('\n'))
}

const args     = process.argv.slice(2)
const chainArg = args[args.indexOf('--chain') + 1] ?? 'local'
const env      = readEnv()
const chainId  = chainArg === 'mainnet' ? '2020' : chainArg === 'saigon' ? '2021' : '31337'
const rpcUrl   = chainArg === 'mainnet'
  ? (env.get('RONIN_RPC_URL')  ?? 'https://api.roninchain.com/rpc')
  : chainArg === 'saigon'
  ? (env.get('SAIGON_RPC_URL') ?? 'https://saigon-testnet.roninchain.com/rpc')
  : (env.get('RONIN_RPC_URL')  ?? 'http://127.0.0.1:8545')

console.log(`\nDeploying Staking to chain ${chainId} via ${rpcUrl} …\n`)
try {
  execSync(
    `forge script script/DeployStaking.s.sol:DeployStaking --rpc-url ${rpcUrl} --broadcast --slow`,
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, RONIN_RPC_URL: rpcUrl } }
  )
} catch {
  process.exit(1)
}

const broadcastFile = path.join(ROOT, 'broadcast', 'DeployStaking.s.sol', chainId, 'run-latest.json')
if (!fs.existsSync(broadcastFile)) {
  console.error(`Broadcast file not found: ${broadcastFile}`)
  process.exit(1)
}

const broadcast = JSON.parse(fs.readFileSync(broadcastFile, 'utf8'))
let staking: string | undefined
for (const tx of broadcast.transactions ?? []) {
  if (tx.transactionType === 'CREATE' && tx.contractName === 'Staking' && tx.contractAddress) {
    staking = tx.contractAddress
    break
  }
}

if (!staking) {
  console.error('Could not find Staking address in broadcast output.')
  process.exit(1)
}

writeEnv({
  STAKING_ADDRESS:     staking,
  NEXT_PUBLIC_STAKING: staking,
})

console.log(`\n.env patched:`)
console.log(`  STAKING_ADDRESS = ${staking}`)
console.log(`\nFinal manual step: owner runs from cold wallet`)
console.log(`  cast send ${env.get('ROBET_NFT_ADDRESS')} "setMinter(address)" ${staking} \\`)
console.log(`    --private-key <OWNER_KEY> --rpc-url ${rpcUrl}`)
