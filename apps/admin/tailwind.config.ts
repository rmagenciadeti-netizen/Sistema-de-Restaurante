import type { Config } from 'tailwindcss';
import base from '../web/tailwind.config';

const config: Config = {
  ...base,
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    '../web/app/**/*.{js,ts,jsx,tsx,mdx}',
    '../web/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
};

export default config;
