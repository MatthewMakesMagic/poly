/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0a0e1a',
          secondary: '#1e293b',
          tertiary: '#334155',
        },
        accent: {
          green: '#34d399',
          yellow: '#fbbf24',
          red: '#f87171',
          blue: '#60a5fa',
          violet: '#a78bfa',
          cyan: '#22d3ee',
        },
        glow: {
          green: 'rgba(52, 211, 153, 0.4)',
          red: 'rgba(248, 113, 113, 0.4)',
          blue: 'rgba(96, 165, 250, 0.4)',
          violet: 'rgba(167, 139, 250, 0.4)',
          yellow: 'rgba(251, 191, 36, 0.4)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { opacity: '0.5' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
