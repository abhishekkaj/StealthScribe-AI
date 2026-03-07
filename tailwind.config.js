/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./*.{html,js}"],
    theme: {
        extend: {
            colors: {
                'stealth-navy': '#0F172A',
                'cobalt-ai': '#6366F1',
                'slate-gray': '#94A3B8',
                'cloud-white': '#F8FAFC',
                'alert-red': '#EF4444'
            }
        },
    },
    plugins: [],
}
