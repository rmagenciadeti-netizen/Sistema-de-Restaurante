import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fbf7ed',
          100: '#f5ecd4',
          300: '#dec17e',
          400: '#c9a64b',
          500: '#b89235',
          600: '#987425',
          700: '#72561c',
        },
        slate: {
          50: '#fafaf9',
          100: '#f4f3f0',
          200: '#e8e6e1',
          300: '#d2cfc8',
          400: '#a5a198',
          500: '#77736a',
          600: '#5e5a52',
          700: '#45423c',
          800: '#302e29',
          900: '#171612',
          950: '#0b0a08',
        },
        blue: {
          50: '#fbf7ed',
          100: '#f5ecd4',
          200: '#ecddb0',
          300: '#dec17e',
          400: '#c9a64b',
          500: '#b89235',
          600: '#987425',
          700: '#72561c',
          800: '#5f491b',
          900: '#4e3d1c',
          950: '#302713',
        },
      },
    },
  },
  plugins: [],
};

export default config;
