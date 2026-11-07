#!/usr/bin/env bash
# Quick Launcher for Maze Live Background
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
INDEX_FILE="$DIR/index.html"

echo "=========================================================="
echo "  🌀 MAZE RUNNER - LIVE AMBIENT BACKGROUND"
echo "=========================================================="
echo "Opening in your default browser..."
echo ""
echo "Shortcuts in browser:"
echo "  [Space]  Pause / Resume simulation"
echo "  [R]      Generate new maze immediately"
echo "  [F]      Toggle Fullscreen"
echo "  [H]      Hide / Show UI overlay (Wallpaper Mode)"
echo "=========================================================="

if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --app="file://$INDEX_FILE" >/dev/null 2>&1 &
elif command -v firefox >/dev/null 2>&1; then
    firefox "$INDEX_FILE" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$INDEX_FILE" >/dev/null 2>&1 &
else
    echo "Please open $INDEX_FILE in any modern web browser."
fi
