# BIS 2026 — Brand Identity & Design System

## Event Identity

| Field | Value |
|---|---|
| Full name | Algeria Brand Impact Summit 2026 |
| Short name | BIS 2026 |
| Brand mark | B.I.S+ |
| Wordmark (navbar) | GET+ |
| Tagline | Le sommet de l'impact africain |
| Date | 15 Novembre 2026 |
| Venue | CIC Alger, Algérie |
| Expected attendance | 12 000 |
| Organizer | Axis Legacy |
| Language | French (fr-DZ) |
| Three pillars | Identity · Growth · Legacy |

### SEO / Metadata

- **Title pattern:** `%s · BIS 2026` (default: `Algeria Brand Impact Summit 2026 — BIS`)
- **Description:** "Le sommet stratégique où les marques sont construites comme des actifs financiers, des outils de souveraineté et des vecteurs d'influence. Trois piliers : Identity, Growth, Legacy."
- **Keywords:** Algeria Brand Impact Summit, BIS 2026, BIS Algeria, Sommet Alger, GET+ Summit, CIC Alger, African impact summit, Identity Growth Legacy, Marque Algérie
- **Open Graph locale:** `fr_DZ`
- **Theme color (browser chrome):** `#2453E0` (cobalt)

---

## Color Palette

### Core tokens (CSS custom properties + Tailwind)

| Token | Hex | Usage |
|---|---|---|
| `--cobalt` / `cobalt.DEFAULT` | `#2453E0` | Primary brand blue — hero backgrounds, links, focus rings, theme-color |
| `cobalt.600` | `#1E44C4` | Hover state for cobalt buttons |
| `cobalt.700` / `--cobalt-700` | `#1339B7` | Deep cobalt for pressed/active states |
| `cobalt.800` | `#0F2F98` | Darkest cobalt variant |
| `--navy` / `navy.DEFAULT` | `#111827` | Dark surfaces, secondary dark tone |
| `navy.800` | `#0B1220` | Deeper navy |
| `navy.900` | `#080D18` | Deepest navy |
| `navy.card` | `#161F33` | Dark card background |
| `navy.card-2` | `#1B2740` | Alternate dark card |
| `--lime` / `lime.DEFAULT` | `#B8E62E` | Primary CTA, accent highlights, selection bg, "+" in wordmark |
| `lime.600` | `#A6D420` | Lime hover state |
| `--frost` | `#F8FAF9` | Light tinted backgrounds, subtle panels |
| `--ink` | `#0A0A0A` | Primary text color, body copy |
| `--line` | `#E6E8ED` | Borders, dividers, card outlines |
| White | `#FFFFFF` | Page background, card fills |

### Role-specific tones (admin panel)

Each role card uses a distinct tone with five sub-tokens (ring, chip, badge, gradient, accent):

| Tone | Ring | Chip | Badge | Gradient | Accent | Assigned to |
|---|---|---|---|---|---|---|
| `lime` | `ring-lime/50` | `bg-lime text-ink` | `bg-lime/25 text-ink` | `from-lime/25 via-lime/8` | `bg-lime` | Super Admin |
| `cobalt` | `ring-cobalt/20` | `bg-cobalt text-white` | `bg-cobalt/10 text-cobalt` | `from-cobalt/12 via-cobalt/4` | `bg-cobalt` | Admin |
| `navy` | `ring-navy/25` | `bg-navy text-white` | `bg-navy/10 text-navy` | `from-navy/12 via-navy/4` | `bg-navy` | Sales |
| `gold` | `ring-amber-400/40` | `bg-amber-400 text-ink` | `bg-amber-400/15 text-amber-700` | `from-amber-300/25 via-amber-200/8` | `bg-amber-400` | VVIP |
| `silver` | `ring-zinc-300` | `bg-zinc-200 text-ink` | `bg-zinc-200 text-zinc-700` | `from-zinc-200/60 via-zinc-100/10` | `bg-zinc-400` | VIP |
| `slate` | `ring-slate-300` | `bg-slate-600 text-white` | `bg-slate-100 text-slate-700` | `from-slate-300/40 via-slate-200/10` | `bg-slate-500` | Visitor |
| `rose` | `ring-rose-300` | `bg-rose-500 text-white` | `bg-rose-100 text-rose-700` | `from-rose-300/25 via-rose-200/8` | `bg-rose-500` | Sponsor |

### Semantic color usage

- **Selection highlight:** lime background + ink text
- **Focus ring:** `focus-visible:ring-cobalt/40`
- **CRUD granted chip:** `bg-lime text-ink`
- **CRUD denied chip:** `bg-ink/5 text-ink/30 line-through`
- **Text opacity scale:** `text-ink` (100%), `text-ink/75`, `text-ink/65`, `text-ink/60`, `text-ink/55`, `text-ink/50`, `text-ink/45`, `text-ink/40`, `text-ink/30`

---

## Typography

### Font family

| Role | Family | Variable | Fallback stack |
|---|---|---|---|
| Body (`font-sans`) | Alexandria (Google Fonts) | `--font-alexandria` | `system-ui, sans-serif` |
| Display (`font-display`) | Alexandria (Google Fonts) | `--font-alexandria` | `system-ui, sans-serif` |
| Email templates | Alexandria | inline | `-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, Helvetica, sans-serif` |

**Weights loaded:** 300, 400, 500, 600, 700, 800, 900  
**Subset:** Latin  
**Display strategy:** `swap`  
**Font feature settings:** `ss01` (stylistic set 1) enabled globally on `body`

### Type scale

#### Fluid display sizes (Tailwind custom `fontSize`)

| Token | Size | Line height | Letter spacing | Weight |
|---|---|---|---|---|
| `hero-xl` | `clamp(3.5rem, 8.4vw, 7.5rem)` | 0.92 | -0.035em | 800 |
| `hero-lg` | `clamp(2.5rem, 6vw, 5rem)` | 0.95 | -0.03em | 800 |
| `section-xl` | `clamp(2.25rem, 4.5vw, 3.75rem)` | 1.02 | -0.025em | 800 |
| `section-lg` | `clamp(1.75rem, 3vw, 2.5rem)` | 1.1 | -0.02em | 700 |
| `stat` | `clamp(2.5rem, 5.5vw, 4rem)` | 1 | -0.03em | 800 |

#### Fixed sizes used across the codebase

| Context | Size | Weight | Tracking | Notes |
|---|---|---|---|---|
| Navbar wordmark | 22px | extrabold (800) | tight | `font-display` |
| Card title | 17px | black (900) | tight | `font-display` |
| Stat value (card) | 20px | black (900) | tight | `font-display`, tabular-nums |
| Stat label (card) | 9.5px | bold (700) | 0.2em | uppercase |
| Section heading | 11px | bold (700) | 0.24em | uppercase, muted |
| Eyebrow | 11px | semibold (600) | 0.22em | uppercase |
| Body headline | 13.5px | semibold (600) | normal | leading-snug |
| Body summary | 12.5px | normal | normal | leading-relaxed, muted |
| Nav link | 13px | medium (500) | tight | — |
| Button text | 13px / 14px | semibold (600) | normal | — |
| CRUD chip (sm) | 9.5px | bold (700) | 0.06em | uppercase |
| CRUD chip (md) | 10px | bold (700) | 0.08em | uppercase |
| Mobile nav item | 24px (2xl) | bold (700) | tight | `font-display` |

---

## Spacing & Layout

### Container

- Max width: **1280px**
- Horizontal padding: `clamp(1.25rem, 5vw, 3.5rem)`
- Tailwind container center: true
- Breakpoint padding: sm → 1.5rem, lg → 2rem, xl → 3rem

### Structural dimensions

| Element | Value | CSS variable |
|---|---|---|
| Ticker bar height | 28px | `--ticker-height` |
| Navbar height | 68px | `--nav-height` |
| Scroll padding top | ticker + nav + 16px | computed |
| Card border radius | 10px | `rounded-card` |
| Button border radius | 8px | `rounded-btn` |

### Grid patterns

- Staff role cards: `grid-cols-1 → md:2 → xl:3`, gap-4
- Public role cards: `grid-cols-1 → md:2 → xl:4`, gap-4
- Intro section: `lg:grid-cols-[1.4fr_1fr]`, gap-6

---

## Component Classes (Tailwind @layer components)

| Class | Definition |
|---|---|
| `.container-page` | Centered max-w-[1280px] with fluid padding |
| `.eyebrow` | 11px semibold uppercase tracking-[0.22em] ink/70 |
| `.eyebrow-invert` | Same as eyebrow but white/70 |
| `.btn-lime` | Lime bg, rounded-btn, px-5 py-2.5, 13px semibold, hover:lime-600 |
| `.btn-lime-lg` | Lime bg, rounded-btn, px-6 py-3.5, sm semibold, hover:lime-600 |
| `.btn-outline-white` | Transparent bg, white/25 border, hover:white/50 border + white/5 bg |
| `.btn-ghost` | White bg, line border, hover:ink/30 border |
| `.chip` | Rounded-full, white/20 border, white/6 bg, backdrop-blur, 12px medium |
| `.card` | rounded-card, line border, white bg |

---

## Utility Patterns

| Utility | Purpose |
|---|---|
| `.text-balance` | `text-wrap: balance` |
| `.grid-lines-dark` | 64px grid overlay with white/5 lines (for dark backgrounds) |
| `.noise` | SVG fractal noise texture overlay |
| `.hero-flush` | Negative margin to reclaim header space for full-bleed hero sections |

---

## Animations

| Name | Duration | Easing | Usage |
|---|---|---|---|
| `marquee` | 55s | linear infinite | Ticker scroll |
| `fade-up` | 0.6s | cubic-bezier(0.16, 1, 0.3, 1) | Content entrance |
| `orbit-slow` | 60s | linear infinite | Decorative rotation |
| `pulse-soft` | 2.4s | ease-in-out infinite | Subtle opacity pulse |
| `auth-content` | — | — | Auth page content fade+slide |
| `auth-grid` | — | — | Auth page grid drift |
| `auth-float-a/b` | — | — | Auth page floating shapes |
| `contact-drift-a/b` | — | — | Contact page floating shapes |
| `contact-check` | — | — | Checkmark stroke draw |

**Accessibility:** All animations disabled when `prefers-reduced-motion: reduce` is active.

---

## Navigation Structure

### Public navbar

- **Wordmark:** `GET+` (the "+" is always lime-colored)
- **Links:** Programme · Intervenants · Espaces
- **CTAs:** "Se connecter" (ghost/text) · "S'inscrire" (btn-lime with → arrow)
- **Behavior over hero:** transparent background, white text
- **Behavior scrolled/non-home:** white/95 bg + backdrop-blur, dark text, bottom border
- **Mobile:** hamburger toggle, full-screen overlay menu with large type

### Admin panel

- Separate layout — no ticker, no navbar, no footer
- Uses `AdminHeader` component per page
- Min-height screen fill

---

## Roles & Permissions Visual System

### Staff roles

| Role | Initials | Tone | Tag | Headline |
|---|---|---|---|---|
| Super Admin | SA | lime | Staff · Contrôle total | Possède la plateforme. |
| Admin | AD | cobalt | Staff · Opérations | Gère les opérations quotidiennes. |
| Sales | SL | navy | Staff · Inscriptions | S'occupe des inscrits et du suivi commercial. |

### Public roles

| Role | Initials | Tone | Tag | Headline |
|---|---|---|---|---|
| VVIP | VV | gold | Attendee · Top tier | Accès participant en lecture seule. |
| VIP | VI | silver | Attendee | Accès participant en lecture seule. |
| Visitor | VS | slate | Attendee · Grand public | Accès participant en lecture seule. |
| Sponsor | SP | rose | Partner | Espace sponsor en lecture seule. |

### CRUD operations

| Op | Label (FR) | Short |
|---|---|---|
| create | Créer | C |
| read | Voir | R |
| update | Modifier | U |
| delete | Supprimer | D |
| export | Exporter | E |
| email | Envoyer email | @ |

---

## Assets

| File | Purpose |
|---|---|
| `public/rising-i.png` | Brand/event image |
| `public/speakers/1.webp` | Speaker photo |
| `public/speakers/2.png` | Speaker photo |
| `public/speakers/3.png` | Speaker photo |
| `public/speakers/4.png` | Speaker photo |
| `public/speakers/55.png` | Speaker photo |

> No dedicated logo SVG/PNG found — the wordmark `GET+` is rendered typographically in the navbar using `font-display` at 22px extrabold with a lime `+`.

---

## Technical Notes

- **Rendering:** Antialiased font smoothing enforced globally (`-webkit-font-smoothing: antialiased`)
- **Scroll behavior:** Smooth scrolling with padding accounting for fixed ticker + nav
- **Hydration:** `suppressHydrationWarning` on `<html>` and `<body>` (Next.js font optimization)
- **Structured data:** JSON-LD Event schema injected in root layout
- **Font loading:** Google Fonts via `next/font/google` with CSS variable strategy for zero-layout-shift