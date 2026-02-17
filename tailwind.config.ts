import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,html}"],
  theme: {
    fontFamily: {
      sans: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
    },
    fontSize: {
      xs: ["0.75rem", { lineHeight: "1rem" }],
      sm: ["0.875rem", { lineHeight: "1.25rem" }],
      base: ["1rem", { lineHeight: "1.5rem" }],
      lg: ["1.125rem", { lineHeight: "1.75rem" }],
      xl: ["1.25rem", { lineHeight: "1.75rem" }],
      "2xl": ["1.5rem", { lineHeight: "2rem" }],
      "3xl": ["1.875rem", { lineHeight: "2.25rem" }],
      "4xl": ["2.25rem", { lineHeight: "2.5rem" }],
    },
    extend: {
      colors: {
        surface: {
          900: "#0f172a", // slate-900 — primary background
          800: "#1e293b", // slate-800 — card / panel background
          700: "#334155", // slate-700 — elevated surfaces / borders
        },
        accent: {
          DEFAULT: "#fbbf24", // amber-400
          hover: "#f59e0b",   // amber-500
        },
        semantic: {
          success: "#34d399", // emerald-400
          error: "#f87171",   // red-400
          info: "#60a5fa",    // blue-400
          warning: "#fbbf24", // amber-400
        },
      },
    },
  },
  plugins: [],
};

export default config;
