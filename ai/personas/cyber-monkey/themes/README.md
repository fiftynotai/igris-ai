# 🔥 Fifty Design Language (FDL) - Terminal Themes

**Version:** 1.0
**Maintainer:** Mohamed Elamin (fifty.dev)
**Brand Philosophy:** *Tech + Personality (Base) · Neo-Tech Industrial (Accent)*

Terminal color themes implementing the **Fifty Design Language** for the Crimson cyber monkey guardian persona.

---

## 🎨 Design System

Based on the official **Fifty Design Language (FDL)** v1.0:

### Brand Colors

| Role | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Primary Crimson** | `#960E29` | `150, 14, 41` | Base identity color |
| **Tech Crimson** | `#B31337` | `179, 19, 55` | Accent for glow/focus |

### Surface Hierarchy

| Level | Hex | RGB | Usage |
|-------|-----|-----|-------|
| **Surface 0** | `#0E0E0F` | `14, 14, 15` | Background |
| **Surface 1** | `#161617` | `22, 22, 23` | Card base |
| **Surface 2** | `#1D1D1F` | `29, 29, 31` | Panel |
| **Surface 3** | `rgba(255,255,255,0.03)` | — | Floating layer |

### Text Hierarchy

| Role | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Text Primary** | `#FFFFFF` | `255, 255, 255` | White |
| **Text Secondary** | `#E5E5E7` | `229, 229, 231` | Gray |
| **Text Muted** | `#9E9EA0` | `158, 158, 160` | Subtle text |

### Borders & Dividers

| Role | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Border** | `#2C2C2E` | `44, 44, 46` | Borders |
| **Divider** | `#3A3A3C` | `58, 58, 60` | Dividers |

### State Colors

| State | Hex | RGB | Usage |
|-------|-----|-----|-------|
| **Success** | `#00BA33` | `0, 186, 51` | Success states |
| **Warning** | `#F7A100` | `247, 161, 0` | Warning states |
| **Error** | `#B31337` | `179, 19, 55` | Error (uses Tech Crimson) |

---

## 📦 Available Themes

### 1. Terminal.app Theme (macOS Default)

**File:** `Crimson.terminal`

**Installation:**
```bash
# Option 1: Double-click the file
open ai/personas/cyber-monkey/themes/Crimson.terminal

# Option 2: Import via Terminal.app
# Terminal > Preferences > Profiles > Import > Select Crimson.terminal
```

**Features:**
- Background: Surface 1 (#161617)
- Text: Text Primary (#FFFFFF) / Text Secondary (#E5E5E7)
- Cursor: Primary Crimson (#960E29)
- Selection: Tech Crimson with transparency
- ANSI colors optimized for FDL hierarchy
- SFMono font (14.5pt) with proper spacing

---

### 2. iTerm2 Theme

**File:** `Crimson.itermcolors`

**Installation:**
```bash
# Option 1: Double-click the file
open ai/personas/cyber-monkey/themes/Crimson.itermcolors

# Option 2: Import via iTerm2
# iTerm2 > Preferences > Profiles > Colors > Color Presets > Import
# Select Crimson.itermcolors
```

**Features:**
- Full 16-color ANSI palette following FDL
- Surface hierarchy support
- Crimson cursor, selection, links
- Badge color support
- Cursor guide for navigation

---

## 🚀 Startup Hook Integration

The `.claude/hooks/startup.sh` script automatically uses FDL colors when the cyber-monkey persona is active.

**FDL ANSI Color Variables:**
```bash
# Brand Colors
FDL_CRIMSON="\033[38;2;150;14;41m"        # #960E29
FDL_TECH_CRIMSON="\033[38;2;179;19;55m"   # #B31337

# Surface Hierarchy
FDL_SURFACE_0="\033[48;2;14;14;15m"       # #0E0E0F
FDL_SURFACE_1="\033[48;2;22;22;23m"       # #161617
FDL_SURFACE_2="\033[48;2;29;29;31m"       # #1D1D1F

# Text Hierarchy
FDL_TEXT_PRIMARY="\033[38;2;255;255;255m"   # #FFFFFF
FDL_TEXT_SECONDARY="\033[38;2;229;229;231m" # #E5E5E7
FDL_TEXT_MUTED="\033[38;2;158;158;160m"     # #9E9EA0

# Borders & Dividers
FDL_BORDER="\033[38;2;44;44;46m"          # #2C2C2E
FDL_DIVIDER="\033[38;2;58;58;60m"         # #3A3A3C

# States
FDL_SUCCESS="\033[38;2;0;186;51m"         # #00BA33
FDL_WARNING="\033[38;2;247;161;0m"        # #F7A100
FDL_ERROR="\033[38;2;179;19;55m"          # #B31337

# Utilities
FDL_BOLD="\033[1m"
FDL_DIM="\033[2m"
FDL_RESET="\033[0m"
```

**Activation:**
FDL colors activate automatically when:
1. `ai/persona.json` exists
2. `persona` field = `"cyber-monkey"`
3. Igris AI startup hook runs

---

## 🎯 Color Usage Philosophy

Following FDL guidelines:

**Crimson Usage (≤15% in UI):**
- Primary Crimson: Identity elements, key accents, task highlights
- Tech Crimson: Active states, in-progress indicators, focus states

**Hierarchy:**
- Text Primary (#FFFFFF): Headers, important info
- Text Secondary (#E5E5E7): Body text, labels
- Text Muted (#9E9EA0): Subtle info, completed items

**States:**
- Success (#00BA33): Ready items, no blockers
- Warning (#F7A100): Blockers present, high priority
- Error (#B31337): Critical priority, errors

---

## ✅ Testing

**Test FDL colors in terminal:**
```bash
# Run the startup hook manually
./.claude/hooks/startup.sh

# Or restart Claude Code CLI (colors appear automatically)
```

**Run visual color test:**
```bash
./ai/personas/cyber-monkey/themes/test_colors.sh
```

**Expected output with cyber-monkey persona:**
- 🔥 Crimson banner: "🐒🔥 CRIMSON ONLINE 🔥🐒"
- 🎯 FDL-colored stats following proper hierarchy
- ⚡ State colors for success/warning/error
- Proper text hierarchy (Primary > Secondary > Muted)

**Expected output without persona or with other personas:**
- Standard terminal colors (no FDL)
- Igris shadow knight banner (if igris + full mask)

---

## 🐒 FDL ANSI Color Mapping

**ANSI Color Palette:**
- **ANSI 0 (Black):** Surface 1 (#161617)
- **ANSI 1 (Red):** Primary Crimson (#960E29)
- **ANSI 2-6:** Crimson variants
- **ANSI 7 (White):** Text Secondary (#E5E5E7)
- **ANSI 8 (Bright Black):** Border (#2C2C2E)
- **ANSI 9 (Bright Red):** Tech Crimson (#B31337)
- **ANSI 10 (Bright Green):** Success (#00BA33)
- **ANSI 11 (Bright Yellow):** Warning (#F7A100)
- **ANSI 15 (Bright White):** Text Primary (#FFFFFF)

---

## 🔧 Customization

**To modify colors:**
1. Update FDL specification in brand documentation
2. Regenerate ANSI codes in `.claude/hooks/startup.sh`
3. Regenerate terminal theme files (or edit XML directly)
4. Update `ai/personas/cyber-monkey/persona.json` branding section

**Color conversion:**
```bash
# Hex to RGB
#960E29 → R:150, G:14, B:41

# RGB to ANSI escape code (24-bit true color)
RGB(150, 14, 41) → \033[38;2;150;14;41m  # Foreground
RGB(150, 14, 41) → \033[48;2;150;14;41m  # Background
```

---

## 📚 References

- **FDL Specification:** Project design system documentation
- **Persona Config:** `ai/personas/cyber-monkey/persona.json`
- **Startup Hook:** `.claude/hooks/startup.sh`
- **Terminal.app Format:** XML plist with NSColor objects
- **iTerm2 Format:** XML plist with RGB color dictionaries
- **ANSI Escape Codes:** [ANSI Color Codes](https://en.wikipedia.org/wiki/ANSI_escape_code#Colors)

---

## 📐 Design Philosophy

> **"Design systems aren't about colors and buttons — they're about memory. When someone sees your crimson glow, they should know it's you."**

**Core Principles:**
- Dark mode first (#0E0E0F base)
- Crimson as identity, not decoration (≤15% usage)
- Surface hierarchy for depth
- Text hierarchy for clarity
- State colors for semantics
- Engineering precision over visual noise

---

**Part of the [fifty.dev ecosystem](https://fifty.dev).**

🔥 **Code or chaos? Let's bring the CRIMSON FIRE!** 🐒⚡
