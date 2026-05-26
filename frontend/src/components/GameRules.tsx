'use client'

import { useState } from 'react'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-widest mb-2">{title}</p>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm px-4 py-1.5 border-b border-border last:border-0">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  )
}

function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Card */}
      <div
        className="relative z-10 w-full max-w-md max-h-[85vh] overflow-y-auto bg-card border border-border rounded-2xl p-6 flex flex-col gap-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">How it works</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-white text-xl leading-none transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Game cycle */}
        <Section title="Game cycle">
          <div className="flex items-stretch gap-0 text-xs text-center rounded-xl overflow-hidden border border-border">
            <div className="flex-1 bg-accent/10 px-3 py-3">
              <p className="font-semibold text-accent mb-1">Betting</p>
              <p className="text-muted">1 hour</p>
              <p className="text-muted mt-1">Place LONG or SHORT</p>
            </div>
            <div className="w-px bg-border" />
            <div className="flex-1 px-3 py-3">
              <p className="font-semibold text-muted mb-1">Hold</p>
              <p className="text-muted">1 hour</p>
              <p className="text-muted mt-1">Wait for result</p>
            </div>
            <div className="w-px bg-border" />
            <div className="flex-1 px-3 py-3">
              <p className="font-semibold text-over mb-1">Settle</p>
              <p className="text-muted">at close</p>
              <p className="text-muted mt-1">Claim winnings</p>
            </div>
          </div>
          <p className="text-xs text-muted mt-2">
            A new game starts automatically the moment betting closes - games run back-to-back.
          </p>
        </Section>

        {/* Rules */}
        <Section title="Winning conditions">
          <div className="rounded-xl border border-border overflow-hidden">
            <Row label="↑ LONG wins" value="End price > Entry price" />
            <Row label="↓ SHORT wins" value="End price < Entry price" />
            <Row label="Tie" value="Full refund to all players" />
          </div>
        </Section>

        {/* Price oracle */}
        <Section title="How RON price is calculated">
          <p className="text-sm text-muted leading-relaxed">
            The price is read directly from two{' '}
            <span className="text-white font-medium">Katana V2</span> liquidity pools on-chain:
          </p>
          <div className="mt-2 rounded-xl border border-border overflow-hidden text-xs font-mono">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <span className="text-muted">Step 1</span>
              <span className="text-white">WRON / WETH pool → RON per ETH</span>
            </div>
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <span className="text-muted">Step 2</span>
              <span className="text-white">WETH / USDC pool → ETH per USD</span>
            </div>
            <div className="px-4 py-2.5 flex items-center gap-2 bg-accent/5">
              <span className="text-muted">Result</span>
              <span className="text-accent">RON/USD = RON/ETH × ETH/USD</span>
            </div>
          </div>
          <p className="text-xs text-muted mt-2">
            No external oracles - prices are read directly from on-chain pool reserves.
          </p>
        </Section>

        {/* Snapshots */}
        <Section title="Price snapshots">
          <div className="rounded-xl border border-border overflow-hidden">
            <Row label="Entry price" value="Locked when betting closes" />
            <Row label="End price"   value="Read at the resolution block (1 h later)" />
          </div>
          <p className="text-xs text-muted mt-2">
            A keeper wallet calls <span className="font-mono text-white">snapshot()</span> within
            10 blocks of betting closing to lock the entry price on-chain.
            Anyone can trigger it as a fallback.
          </p>
        </Section>

        {/* Payouts */}
        <Section title="Payouts">
          <div className="rounded-xl border border-border overflow-hidden">
            <Row label="Winner's share"    value="Stake back + pro-rata losing pot" />
            <Row label="Protocol fee"      value="2% of losing pot" />
            <Row label="PoD rebate (loser)" value="Share of Ronin PoD rewards (80%)" />
            <Row label="PoD bonus (winner)" value="Share of Ronin PoD rewards (10%)" />
          </div>
          <p className="text-xs text-muted mt-2">
            PoD rewards arrive separately via Ronin's Proof-of-Distribution program and are
            claimable at any time from the Rewards tab.
          </p>
        </Section>
      </div>
    </div>
  )
}

export function GameRulesButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="How it works"
        className="text-muted hover:text-white text-xs border border-border rounded-full w-5 h-5 flex items-center justify-center transition-colors"
      >
        ?
      </button>
      {open && <RulesModal onClose={() => setOpen(false)} />}
    </>
  )
}
