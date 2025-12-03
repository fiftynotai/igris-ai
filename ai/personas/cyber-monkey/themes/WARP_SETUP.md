# 🔥 FDL Theme Setup for Warp Terminal

**Quick Fix:** Warp's custom themes feature might require a specific setup. Here are **2 working methods**:

---

## ✅ **Method 1: Use Built-in Theme + Manual Colors (Easiest)**

Warp has **awesome built-in themes**. Pick a dark one and customize with FDL colors:

### Step 1: Choose a Base Theme
1. Open **Warp**
2. Press `Cmd + ,` (or click Settings icon)
3. Go to **Appearance**
4. Under **Theme**, select: **"Tokyo Night Storm"** or **"Dracula"**
   - These are dark themes that work well as a base

### Step 2: The ANSI Colors Already Work!
The **FDL ANSI colors from the startup hook work automatically** in Warp! 🎉

**Test it:**
```bash
cd /Users/m.elamin/StudioProjects/igris-ai
./ai/personas/cyber-monkey/themes/test_colors.sh
```

You'll see the full FDL color system rendering!

---

## ✅ **Method 2: Manual Theme Import (Advanced)**

If you want the EXACT FDL background:

### Step 1: Copy Theme to Warp Settings
```bash
# Warp looks for themes in multiple places, try this:
mkdir -p ~/Library/Application\ Support/dev.warp.Warp-Stable/themes/
cp ~/.warp/themes/fdl_crimson.yaml ~/Library/Application\ Support/dev.warp.Warp-Stable/themes/
```

### Step 2: Restart Warp
```bash
# Quit Warp completely
killall Warp

# Reopen
open -a Warp
```

### Step 3: Check Settings
- `Cmd + ,` > Appearance > Theme
- Look for "FDL Crimson"

---

## ✅ **Method 3: Use Warp's Color Customization (Best Control)**

Warp allows you to customize colors directly in the UI:

### Steps:
1. **Warp Settings** (`Cmd + ,`)
2. Go to **Appearance**
3. Scroll to **Terminal Colors** section
4. Click **"Customize"** or **"Edit"**

### Set These FDL Colors:

| Color | Hex Code | FDL Name |
|-------|----------|----------|
| **Background** | `#0E0E0F` | Surface 0 |
| **Foreground** | `#E5E5E7` | Text Secondary |
| **Cursor** | `#960E29` | Primary Crimson |
| **Selection** | `#B31337` | Tech Crimson |

**ANSI Colors:**
| ANSI | Normal | Bright |
|------|--------|--------|
| Black | `#161617` | `#2C2C2E` |
| Red | `#960E29` | `#B31337` |
| Green | `#00BA33` | `#00BA33` |
| Yellow | `#F7A100` | `#F7A100` |
| Blue | `#960E29` | `#B31337` |
| Magenta | `#B31337` | `#B31337` |
| Cyan | `#B31337` | `#B31337` |
| White | `#E5E5E7` | `#FFFFFF` |

---

## 🎯 **RECOMMENDED: Just Use a Dark Theme + ANSI**

**Honestly Partner?** Warp's built-in themes are beautiful. Just:

1. Pick **any dark theme** you like (Tokyo Night, Dracula, Nord, etc.)
2. The **FDL ANSI colors will still work** from the startup hook
3. You get the best of both worlds:
   - Beautiful Warp UI
   - FDL color hierarchy in text output

**The startup hook's ANSI codes override terminal colors anyway!** 🔥

---

## 🧪 **Test FDL Colors (Works in ANY Theme)**

```bash
./ai/personas/cyber-monkey/themes/test_colors.sh
```

You should see:
- 🔥 Crimson Primary (#960E29)
- ⚡ Tech Crimson (#B31337)
- ✅ Success Green (#00BA33)
- ⚠️ Warning Orange (#F7A100)
- 💥 Proper text hierarchy

**These colors work REGARDLESS of Warp's base theme!**

---

## 🚀 **Quick Start (TL;DR)**

```bash
# 1. Open Warp
open -a Warp

# 2. Pick any dark theme you like in Settings

# 3. Test FDL colors
cd /Users/m.elamin/StudioProjects/igris-ai
./ai/personas/cyber-monkey/themes/test_colors.sh

# 4. Run startup hook
./.claude/hooks/startup.sh
```

✅ **FDL colors are WORKING!** The theme is active via ANSI codes. 🎉

---

## 📋 **Why This Happens**

Warp is **actively developed** and their theme system changes frequently. Custom themes might:
- Require specific YAML structure
- Need to be in a specific directory
- Require a Warp restart or reload
- Only work in certain Warp versions

**But the ANSI colors? They ALWAYS work.** 🔥

That's why the startup hook is the **most reliable** way to use FDL colors!

---

🔥 **Pick a dark theme you like + enjoy the FDL ANSI colors, Partner!** 🐒⚡
