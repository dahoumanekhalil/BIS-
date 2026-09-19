import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: "1.25rem",
        sm: "1.5rem",
        lg: "2rem",
        xl: "3rem"
      },
      screens: {
        "2xl": "1280px"
      }
    },
    extend: {
      colors: {
        cobalt: {
          DEFAULT: "#2453E0",
          600: "#1E44C4",
          700: "#1339B7",
          800: "#0F2F98"
        },
        navy: {
          DEFAULT: "#111827",
          800: "#0B1220",
          900: "#080D18",
          card: "#161F33",
          "card-2": "#1B2740"
        },
        lime: {
          DEFAULT: "#B8E62E",
          600: "#A6D420"
        },
        frost: "#F8FAF9",
        ink: "#0A0A0A",
        line: "#E6E8ED"
      },
      fontFamily: {
        sans: ["var(--font-alexandria)", "system-ui", "sans-serif"],
        display: ["var(--font-alexandria)", "system-ui", "sans-serif"]
      },
      fontSize: {
        "hero-xl": ["clamp(3.5rem, 8.4vw, 7.5rem)", { lineHeight: "0.92", letterSpacing: "-0.035em", fontWeight: "800" }],
        "hero-lg": ["clamp(2.5rem, 6vw, 5rem)", { lineHeight: "0.95", letterSpacing: "-0.03em", fontWeight: "800" }],
        "section-xl": ["clamp(2.25rem, 4.5vw, 3.75rem)", { lineHeight: "1.02", letterSpacing: "-0.025em", fontWeight: "800" }],
        "section-lg": ["clamp(1.75rem, 3vw, 2.5rem)", { lineHeight: "1.1", letterSpacing: "-0.02em", fontWeight: "700" }],
        stat: ["clamp(2.5rem, 5.5vw, 4rem)", { lineHeight: "1", letterSpacing: "-0.03em", fontWeight: "800" }]
      },
      borderRadius: {
        card: "10px",
        btn: "8px"
      },
      keyframes: {
        marquee: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" }
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        "orbit-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" }
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" }
        }
      },
      animation: {
        marquee: "marquee 55s linear infinite",
        "fade-up": "fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both",
        "orbit-slow": "orbit-slow 60s linear infinite",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite"
      }
    }
  },
  plugins: []
};

export default config;
