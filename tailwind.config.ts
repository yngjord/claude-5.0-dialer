import type { Config } from 'tailwindcss';

// Tokens mirror maronly.com.au (assets/css/site.css)
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#2464d7',
          hover: '#1d52b3',
          soft: 'rgba(36, 100, 215, 0.12)',
          tint: '#eef3fc',
        },
        ink: { DEFAULT: '#000000', soft: '#222222', muted: '#6b6b6b', faint: '#a1a1a1' },
        line: { DEFAULT: '#e3e3e3', strong: '#cccccc', border: '#adadad' },
      },
      fontFamily: {
        brand: ['Comfortaa', 'sans-serif'],
        display: ['Montserrat', 'sans-serif'],
        body: ['Figtree', 'sans-serif'],
      },
      borderRadius: { card: '25px' },
      boxShadow: {
        card: '0 10px 30px rgba(0, 0, 0, 0.05)',
        btn: '0 8px 20px rgba(36, 100, 215, 0.28)',
      },
      transitionTimingFunction: { out: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      keyframes: {
        appear: { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'none' } },
        'loading-bar': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(300%)' } },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
        draw: { from: { strokeDasharray: '1', strokeDashoffset: '1' }, to: { strokeDasharray: '1', strokeDashoffset: '0' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        appear: 'appear 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
        'loading-bar': 'loading-bar 1.1s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        shimmer: 'shimmer 1.6s linear infinite',
        draw: 'draw 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.5s ease-out both',
      },
    },
  },
  plugins: [],
} satisfies Config;
