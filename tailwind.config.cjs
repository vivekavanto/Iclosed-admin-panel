/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand-black': '#1f2937',
        'brand-primary': '#e11d48',
        'brand-primaryHover': '#be123c',
        'brand-light': '#ffe4e6',
        'brand-accent': '#f43f5e',
        'brand-blue': '#2563eb',
        'brand-orange': '#f97316',
        'brand-purple': '#9333ea',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      'light',
      'dark'
    ],
  },
}
