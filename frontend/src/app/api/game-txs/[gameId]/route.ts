import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params
  const file = path.join(process.cwd(), 'data', 'txs', `game-${gameId}.json`)
  try {
    return NextResponse.json(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return NextResponse.json({})
  }
}
