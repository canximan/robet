import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const DIR = path.join(process.cwd(), 'data', 'claims')

// kind enumerates every user-visible RON-affecting action we record.
// Game-side actions reference a gameId; staking-side actions don't.
type ClaimKind = 'pot' | 'rebate' | 'bonus' | 'stake' | 'unstake' | 'stake-pod'

type ClaimRecord = {
  gameId: string         // empty string for staking events
  kind: ClaimKind
  amount: string
  txHash: string
  claimedAt: string
}

function filePath(address: string) {
  return path.join(DIR, `${address.toLowerCase()}.json`)
}

function readClaims(address: string): ClaimRecord[] {
  try {
    return JSON.parse(fs.readFileSync(filePath(address), 'utf8'))
  } catch {
    return []
  }
}

function writeClaims(address: string, records: ClaimRecord[]) {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(filePath(address), JSON.stringify(records, null, 2))
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get('address')
  if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 })
  const records = readClaims(address)
  return NextResponse.json(records.slice().reverse()) // newest first
}

export async function POST(req: NextRequest) {
  const { address, gameId, kind, amount, txHash } = await req.json()
  // gameId is optional (staking events have no gameId); the rest are required.
  if (!address || !kind || !amount || !txHash) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }
  const records = readClaims(address)
  if (records.some(r => r.txHash === txHash)) {
    return NextResponse.json({ ok: true, duplicate: true })
  }
  records.push({
    gameId:    gameId ?? '',
    kind,
    amount,
    txHash,
    claimedAt: new Date().toISOString(),
  })
  writeClaims(address, records)
  return NextResponse.json({ ok: true })
}
