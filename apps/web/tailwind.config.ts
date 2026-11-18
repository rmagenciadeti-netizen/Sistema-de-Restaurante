import type { Config } from 'tailwindcss';

// Colors come from CSS variables (app/palettes.css, app/globals.css) so the whole UI follows the selected mode, primary and sidebar colors.
const scale = (prefix: string, steps: number[]) => Object.fromEntries(steps.map(step => [step, `rgb(var(--${prefix}-${step}) / <alpha-value>)`]));

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: scale('b', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        // Legacy `blue-*` classes were remapped to the primary color; keep them following the chosen theme.
        blue: scale('b', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        slate: { ...scale('s', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]), 950: '#0b0a08' },
      },
    },
  },
  plugins: [],
};

export default config;
