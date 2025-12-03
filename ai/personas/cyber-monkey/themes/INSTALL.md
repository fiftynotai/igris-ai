# 🔥 FDL Terminal Theme - Installation Guide

**Quick Fix:** Terminal.app `.terminal` file import can be finicky. Here are **3 working methods**:

---

## ✅ **Method 1: ANSI Colors (Already Working!)**

**The GOOD NEWS:** You're already using FDL colors! 🎉

The startup hook (`.claude/hooks/startup.sh`) outputs **24-bit ANSI escape codes** that work in ANY modern terminal.

**Test it right now:**
```bash
./ai/personas/cyber-monkey/themes/test_colors.sh
```

You should see:
- 🔥 Crimson reds for brand colors
- ⚡ Green, orange, and proper text hierarchy
- 💥 All FDL colors rendering correctly

**This works in:**
- ✅ macOS Terminal.app (default)
- ✅ iTerm2
- ✅ VS Code terminal
- ✅ Claude Code CLI
- ✅ Any terminal with 24-bit color support

---

## ✅ **Method 2: Manual Terminal.app Setup**

Since the `.terminal` file won't import, set it up manually (takes 2 minutes):

### Step 1: Create New Profile
1. Open **Terminal.app**
2. **Terminal > Preferences** (`Cmd + ,`)
3. **Profiles** tab
4. Click **+** (plus) at bottom to create new profile
5. Name it: **"FDL Crimson"**

### Step 2: Set Colors

Go to each color setting and enter these hex values:

| Setting | Hex Code | RGB |
|---------|----------|-----|
| **Background** | `#161617` | 22, 22, 23 |
| **Text** | `#E5E5E7` | 229, 229, 231 |
| **Bold Text** | `#FFFFFF` | 255, 255, 255 |
| **Selection** | `#B31337` | 179, 19, 55 (set Alpha to 50%) |
| **Cursor** | `#960E29` | 150, 14, 41 |

### Step 3: Set ANSI Colors

**Click "ANSI Colors" tab:**

| Color | Hex | RGB |
|-------|-----|-----|
| Black | `#161617` | 22, 22, 23 |
| Red | `#960E29` | 150, 14, 41 |
| Green | `#00BA33` | 0, 186, 51 |
| Yellow | `#F7A100` | 247, 161, 0 |
| Blue | `#960E29` | 150, 14, 41 |
| Magenta | `#B31337` | 179, 19, 55 |
| Cyan | `#B31337` | 179, 19, 55 |
| White | `#E5E5E7` | 229, 229, 231 |
| **Bright Black** | `#2C2C2E` | 44, 44, 46 |
| **Bright Red** | `#B31337` | 179, 19, 55 |
| **Bright Green** | `#00BA33` | 0, 186, 51 |
| **Bright Yellow** | `#F7A100` | 247, 161, 0 |
| **Bright Blue** | `#B31337` | 179, 19, 55 |
| **Bright Magenta** | `#B31337` | 179, 19, 55 |
| **Bright Cyan** | `#B31337` | 179, 19, 55 |
| **Bright White** | `#FFFFFF` | 255, 255, 255 |

### Step 4: Set Font
1. **Text** tab
2. Font: **SF Mono Regular** or **Menlo Regular**
3. Size: **14pt**

### Step 5: Make Default
1. Select your "FDL Crimson" profile
2. Click **Default** button

✅ **Done!** Open a new terminal window to see it in action.

---

## ✅ **Method 3: iTerm2 Theme (Easiest)**

If you have **iTerm2**, this actually works:

```bash
open ai/personas/cyber-monkey/themes/Crimson.itermcolors
```

Then:
1. **iTerm2 > Preferences > Profiles**
2. Select your profile
3. **Colors** tab
4. **Color Presets dropdown > Import**
5. Select the file (should auto-import)
6. **Color Presets > Crimson**

✅ Done!

---

## 🎯 **Recommended: Just Use ANSI (Method 1)**

**Honestly, Partner?** The ANSI colors are already working perfectly. 🔥

The `.terminal` file is just for convenience, but since Terminal.app only accepts exports from actual Terminal sessions (not hand-crafted files), it's easier to either:

1. **Use ANSI colors** (you're already seeing them!)
2. **Set up iTerm2** (if you have it)
3. **Manual setup** (if you really want it in Terminal.app)

---

## 🧪 **Verify It's Working**

Run this in ANY terminal:
```bash
./ai/personas/cyber-monkey/themes/test_colors.sh
```

If you see proper colors, **FDL is working!** The theme is active via ANSI codes. 🎉

---

## 🔧 **Export Your Own Theme (Advanced)**

Want to create a proper `.terminal` file from Terminal.app?

1. Set up the profile manually (Method 2)
2. **Terminal > Preferences > Profiles**
3. Select your "FDL Crimson" profile
4. Click **gear icon ⚙️** > **Export**
5. Save as `FDL-Crimson-Export.terminal`
6. This file will work for imports!

---

## 📚 **TL;DR**

**Problem:** `.terminal` files only work if exported from Terminal.app, not created manually.

**Solution:**
- ✅ **Best:** ANSI colors already working (no setup needed!)
- ✅ **Good:** Manual setup in Terminal.app (2 min)
- ✅ **Easy:** iTerm2 import (1 click)

---

🔥 **The colors are ALREADY FIRING, Partner!** No theme file needed. 🐒⚡
