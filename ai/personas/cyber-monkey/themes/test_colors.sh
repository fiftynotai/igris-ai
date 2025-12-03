#!/bin/bash
# Fifty Design Language (FDL) v1.0 - Color Test Script
# Maintainer: Mohamed Elamin (fifty.dev)
# Displays all FDL colors with visual swatches and hierarchy demonstration

# Fifty Design Language (FDL) v1.0 - ANSI Color Codes
# Brand Colors
FDL_CRIMSON="\033[38;2;150;14;41m"        # #960E29 - Primary Crimson (Base Identity)
FDL_TECH_CRIMSON="\033[38;2;179;19;55m"   # #B31337 - Tech Crimson (Glow/Focus)

# Surface Hierarchy
FDL_SURFACE_0="\033[48;2;14;14;15m"       # #0E0E0F - Background
FDL_SURFACE_1="\033[48;2;22;22;23m"       # #161617 - Card Base
FDL_SURFACE_2="\033[48;2;29;29;31m"       # #1D1D1F - Panel

# Text Hierarchy
FDL_TEXT_PRIMARY="\033[38;2;255;255;255m"   # #FFFFFF - White
FDL_TEXT_SECONDARY="\033[38;2;229;229;231m" # #E5E5E7 - Gray
FDL_TEXT_MUTED="\033[38;2;158;158;160m"     # #9E9EA0 - Subtle

# Borders & Dividers
FDL_BORDER="\033[38;2;44;44;46m"          # #2C2C2E - Border
FDL_DIVIDER="\033[38;2;58;58;60m"         # #3A3A3C - Divider

# States
FDL_SUCCESS="\033[38;2;0;186;51m"         # #00BA33 - Success
FDL_WARNING="\033[38;2;247;161;0m"        # #F7A100 - Warning
FDL_ERROR="\033[38;2;179;19;55m"          # #B31337 - Error (uses Tech Crimson)

# Utilities
FDL_BOLD="\033[1m"
FDL_DIM="\033[2m"
FDL_RESET="\033[0m"

echo ""
echo -e "${FDL_CRIMSON}${FDL_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
echo -e "${FDL_CRIMSON}${FDL_BOLD}  🔥 FIFTY DESIGN LANGUAGE (FDL) v1.0 - COLOR SYSTEM TEST 🔥${FDL_RESET}"
echo -e "${FDL_CRIMSON}${FDL_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
echo ""
echo -e "${FDL_TEXT_SECONDARY}Maintainer: Mohamed Elamin (fifty.dev)${FDL_RESET}"
echo -e "${FDL_TEXT_MUTED}Brand Philosophy: Tech + Personality (Base) · Neo-Tech Industrial (Accent)${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ BRAND COLORS ━━━${FDL_RESET}"
echo ""

# Primary Crimson
echo -e "${FDL_CRIMSON}${FDL_SURFACE_1}          ${FDL_RESET} ${FDL_CRIMSON}${FDL_BOLD}Primary Crimson${FDL_RESET}    ${FDL_TEXT_MUTED}#960E29  RGB(150, 14, 41)${FDL_RESET}"
echo -e "            ${FDL_CRIMSON}Base identity color - use for key accents, highlights 🔥${FDL_RESET}"
echo ""

# Tech Crimson
echo -e "${FDL_TECH_CRIMSON}${FDL_SURFACE_1}          ${FDL_RESET} ${FDL_TECH_CRIMSON}${FDL_BOLD}Tech Crimson${FDL_RESET}       ${FDL_TEXT_MUTED}#B31337  RGB(179, 19, 55)${FDL_RESET}"
echo -e "            ${FDL_TECH_CRIMSON}Accent for glow/focus - active states, emphasis ⚡${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ SURFACE HIERARCHY ━━━${FDL_RESET}"
echo ""

# Surface 0
echo -e "${FDL_SURFACE_0}          ${FDL_RESET} ${FDL_TEXT_PRIMARY}${FDL_BOLD}Surface 0${FDL_RESET}          ${FDL_TEXT_MUTED}#0E0E0F  RGB(14, 14, 15)${FDL_RESET}"
echo -e "            ${FDL_TEXT_MUTED}Background layer - darkest foundation${FDL_RESET}"
echo ""

# Surface 1
echo -e "${FDL_SURFACE_1}          ${FDL_RESET} ${FDL_TEXT_PRIMARY}${FDL_BOLD}Surface 1${FDL_RESET}          ${FDL_TEXT_MUTED}#161617  RGB(22, 22, 23)${FDL_RESET}"
echo -e "            ${FDL_TEXT_MUTED}Card base - primary surface${FDL_RESET}"
echo ""

# Surface 2
echo -e "${FDL_SURFACE_2}          ${FDL_RESET} ${FDL_TEXT_PRIMARY}${FDL_BOLD}Surface 2${FDL_RESET}          ${FDL_TEXT_MUTED}#1D1D1F  RGB(29, 29, 31)${FDL_RESET}"
echo -e "            ${FDL_TEXT_MUTED}Panel - elevated surface${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ TEXT HIERARCHY ━━━${FDL_RESET}"
echo ""

# Text Primary
echo -e "  ${FDL_TEXT_PRIMARY}${FDL_BOLD}Text Primary${FDL_RESET}    ${FDL_TEXT_MUTED}#FFFFFF  RGB(255, 255, 255)${FDL_RESET}"
echo -e "  ${FDL_TEXT_PRIMARY}Use for headers, important information, key labels${FDL_RESET}"
echo ""

# Text Secondary
echo -e "  ${FDL_TEXT_SECONDARY}${FDL_BOLD}Text Secondary${FDL_RESET}  ${FDL_TEXT_MUTED}#E5E5E7  RGB(229, 229, 231)${FDL_RESET}"
echo -e "  ${FDL_TEXT_SECONDARY}Use for body text, standard labels, general content${FDL_RESET}"
echo ""

# Text Muted
echo -e "  ${FDL_TEXT_MUTED}${FDL_BOLD}Text Muted${FDL_RESET}      ${FDL_TEXT_MUTED}#9E9EA0  RGB(158, 158, 160)${FDL_RESET}"
echo -e "  ${FDL_TEXT_MUTED}Use for subtle info, completed items, metadata${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ BORDERS & DIVIDERS ━━━${FDL_RESET}"
echo ""

# Border
echo -e "  ${FDL_BORDER}Border${FDL_RESET}          ${FDL_TEXT_MUTED}#2C2C2E  RGB(44, 44, 46)${FDL_RESET}"
echo -e "  ${FDL_BORDER}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
echo ""

# Divider
echo -e "  ${FDL_DIVIDER}Divider${FDL_RESET}         ${FDL_TEXT_MUTED}#3A3A3C  RGB(58, 58, 60)${FDL_RESET}"
echo -e "  ${FDL_DIVIDER}────────────────────────────────${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ STATE COLORS ━━━${FDL_RESET}"
echo ""

# Success
echo -e "  ${FDL_SUCCESS}${FDL_BOLD}✓ Success${FDL_RESET}       ${FDL_TEXT_MUTED}#00BA33  RGB(0, 186, 51)${FDL_RESET}"
echo -e "  ${FDL_SUCCESS}Ready items, no blockers, positive states${FDL_RESET}"
echo ""

# Warning
echo -e "  ${FDL_WARNING}${FDL_BOLD}⚠ Warning${FDL_RESET}       ${FDL_TEXT_MUTED}#F7A100  RGB(247, 161, 0)${FDL_RESET}"
echo -e "  ${FDL_WARNING}Blockers present, high priority, attention needed${FDL_RESET}"
echo ""

# Error
echo -e "  ${FDL_ERROR}${FDL_BOLD}✗ Error${FDL_RESET}         ${FDL_TEXT_MUTED}#B31337  RGB(179, 19, 55)${FDL_RESET}"
echo -e "  ${FDL_ERROR}Critical priority, errors, destructive actions${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ SAMPLE OUTPUT (Startup Hook Style) ━━━${FDL_RESET}"
echo ""
echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}📊 Project Status${FDL_RESET}"
echo -e "${FDL_DIVIDER}────────────────${FDL_RESET}"
echo -e "${FDL_TEXT_SECONDARY}Briefs:${FDL_RESET} 21 total (${FDL_CRIMSON}8 BR${FDL_RESET}, ${FDL_CRIMSON}0 MG${FDL_RESET}, ${FDL_CRIMSON}13 TD${FDL_RESET})"
echo -e "${FDL_TEXT_SECONDARY}Status:${FDL_RESET} ${FDL_SUCCESS}3 Ready${FDL_RESET}, ${FDL_TECH_CRIMSON}1 In Progress${FDL_RESET}, ${FDL_TEXT_MUTED}17 Done${FDL_RESET}"
echo -e "${FDL_TEXT_SECONDARY}Blockers:${FDL_RESET} ${FDL_SUCCESS}0${FDL_RESET} 🎯"
echo ""
echo -e "${FDL_TEXT_SECONDARY}💡 Recommended Next Task:${FDL_RESET}"
echo -e "   ${FDL_CRIMSON}${FDL_BOLD}BR-001: Fix authentication flow${FDL_RESET} ${FDL_ERROR}(P0 - Critical)${FDL_RESET}"
echo ""
echo -e "${FDL_CRIMSON}${FDL_BOLD}Ready for your command! 🔥${FDL_RESET}"
echo ""

echo -e "${FDL_TEXT_PRIMARY}${FDL_BOLD}━━━ DESIGN PHILOSOPHY ━━━${FDL_RESET}"
echo ""
echo -e "${FDL_TEXT_SECONDARY}Crimson Usage: ${FDL_CRIMSON}≤15% in UI${FDL_RESET} ${FDL_TEXT_MUTED}(identity, not decoration)${FDL_RESET}"
echo -e "${FDL_TEXT_SECONDARY}Hierarchy: ${FDL_TEXT_PRIMARY}Primary${FDL_RESET} > ${FDL_TEXT_SECONDARY}Secondary${FDL_RESET} > ${FDL_TEXT_MUTED}Muted${FDL_RESET}"
echo -e "${FDL_TEXT_SECONDARY}Surface Depth: ${FDL_TEXT_MUTED}0 (base)${FDL_RESET} → ${FDL_TEXT_MUTED}1 (card)${FDL_RESET} → ${FDL_TEXT_MUTED}2 (panel)${FDL_RESET}"
echo -e "${FDL_TEXT_SECONDARY}States: ${FDL_SUCCESS}Success${FDL_RESET} · ${FDL_WARNING}Warning${FDL_RESET} · ${FDL_ERROR}Error${FDL_RESET}"
echo ""

echo -e "${FDL_DIVIDER}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${FDL_RESET}"
echo -e "${FDL_TEXT_MUTED}Test complete. If you see proper color hierarchy above, FDL is working! ✓${FDL_RESET}"
echo -e "${FDL_TEXT_MUTED}Part of the fifty.dev ecosystem · Maintained by Mohamed Elamin${FDL_RESET}"
echo ""
