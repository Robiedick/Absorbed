/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/**/*.{html,js}',
    './src/**/*.{html,js}',
  ],
  safelist: ['hidden', 'opacity-0', 'opacity-100'],
  theme: {
    extend: {
      colors: {
        space: '#020409',
      },
    },
  },
  plugins: [],
};
