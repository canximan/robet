import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:     '#0b0b12',
        card:   '#13131f',
        border: '#2a2a42',
        muted:  '#6b6b8a',
        over:   '#22c55e',   // green
        under:  '#ef4444',   // red
        accent: '#6366f1',
      },
    },
  },
}
export default config
