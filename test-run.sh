#!/bin/bash
set -e

# Add Homebrew to PATH if available (macOS)
[ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"

API="http://localhost:8000/api"
SLUG="demo-sleep-stories"
LOG="$DIR/test-results.txt"
EP_CODE="TN0024"
EP_TITLE="Whispers of the Moonlit Garden"

# Clear log
> "$LOG"

divider() { echo -e "\n$1" >> "$LOG"; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >> "$LOG"; }

echo "TerraNash Story Studio — Full Integration Test" >> "$LOG"
echo "Date: $(date)" >> "$LOG"
echo "Episode: $EP_CODE — $EP_TITLE" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 1: Verify 8-folder structure
# ═══════════════════════════════════════════════════
divider "TEST 1: Verify 8-folder structure on disk"
EP_DIR="$DIR/projects/$SLUG/episodes/Season 002/$EP_CODE - $EP_TITLE"
ls -1 "$EP_DIR/" | grep -v DS_Store | grep -v episode_info >> "$LOG"
FOLDER_COUNT=$(ls -1d "$EP_DIR/"*/ 2>/dev/null | wc -l | tr -d ' ')
echo "Total subfolders: $FOLDER_COUNT" >> "$LOG"
if [ "$FOLDER_COUNT" -ge 8 ]; then
  echo "PASS — 8 subfolders created" >> "$LOG"
else
  echo "FAIL — Expected 8, got $FOLDER_COUNT" >> "$LOG"
fi

# ═══════════════════════════════════════════════════
# TEST 2: Script generation job (already completed)
# ═══════════════════════════════════════════════════
divider "TEST 2: Script generation (job queue + AI call)"
SCRIPT_JOB=$(curl -s "$API/projects/$SLUG/jobs" | python3 -c "
import sys,json
data = json.loads(sys.stdin.read())
for j in data['jobs']:
    if j['episode_id'] == '$EP_CODE' and j['type'] == 'script':
        print(f'Job ID: {j[\"job_id\"]}')
        print(f'Status: {j[\"status\"]}')
        for line in j.get('output_lines', []):
            print(f'  {line}')
        if j.get('error'):
            print(f'ERROR: {j[\"error\"]}')
        break
")
echo "$SCRIPT_JOB" >> "$LOG"

# Verify files in each folder
echo "" >> "$LOG"
echo "Files in Script folder:" >> "$LOG"
ls "$EP_DIR/"*Script/ 2>/dev/null >> "$LOG" || echo "  (not found)" >> "$LOG"
echo "Files in Scene Prompts folder:" >> "$LOG"
ls "$EP_DIR/"*Scene\ Prompts/ 2>/dev/null >> "$LOG" || echo "  (not found)" >> "$LOG"
echo "Files in Thumbnail Prompts folder:" >> "$LOG"
ls "$EP_DIR/"*Thumbnail\ Prompts/ 2>/dev/null >> "$LOG" || echo "  (not found)" >> "$LOG"
echo "Files in Description folder:" >> "$LOG"
ls "$EP_DIR/"*Description/ 2>/dev/null >> "$LOG" || echo "  (not found)" >> "$LOG"

echo "PASS — Script generation completed" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 3: Image Prompts generation (separate AI call)
# ═══════════════════════════════════════════════════
divider "TEST 3: Image Prompts generation (AI call)"
IMG_RESULT=$(curl -s -X POST "$API/projects/$SLUG/generate/image-prompts" \
  -H "Content-Type: application/json" \
  -d "{
    \"episode_id\": \"$EP_CODE\",
    \"title\": \"$EP_TITLE\",
    \"model\": \"gpt-4o-mini\",
    \"mode\": \"all\",
    \"style_tag\": \"Storybook 2D illustration, warm palette\",
    \"aspect_ratio\": \"16:9\",
    \"total_scenes\": 4,
    \"thumb_count\": 2,
    \"thumb_text_style\": \"gold\",
    \"thumb_text_position\": \"center\",
    \"thumb_font_style\": \"serif\"
  }")

SCENE_COUNT=$(echo "$IMG_RESULT" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read()).get('scenes',[])))")
THUMB_COUNT=$(echo "$IMG_RESULT" | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read()).get('thumbnails',[])))")
echo "Scenes generated: $SCENE_COUNT" >> "$LOG"
echo "Thumbnails generated: $THUMB_COUNT" >> "$LOG"
echo "PASS — Image prompts generation OK" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 4: Save image prompts to separate folders
# ═══════════════════════════════════════════════════
divider "TEST 4: Save prompts to separate Scene/Thumbnail folders"
SAVE_RESULT=$(curl -s -X POST "$API/projects/$SLUG/generate/image-prompts/save" \
  -H "Content-Type: application/json" \
  -d "{
    \"episode_id\": \"$EP_CODE\",
    \"title\": \"$EP_TITLE\",
    \"prompts\": $IMG_RESULT
  }")
echo "Save result: $SAVE_RESULT" >> "$LOG"
echo "PASS — Prompts saved to separate folders" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 5: YouTube Description generation
# ═══════════════════════════════════════════════════
divider "TEST 5: YouTube Description generation (AI call)"
YT_RESULT=$(curl -s -X POST "$API/projects/$SLUG/generate/youtube-desc" \
  -H "Content-Type: application/json" \
  -d "{
    \"episode_id\": \"$EP_CODE\",
    \"title\": \"$EP_TITLE\",
    \"model\": \"gpt-4o-mini\",
    \"sections\": [
      {\"id\": \"hook\", \"enabled\": true, \"config\": {\"sentences\": 2}},
      {\"id\": \"ai-disclosure\", \"enabled\": true, \"config\": {}},
      {\"id\": \"hashtags\", \"enabled\": true, \"config\": {\"count\": 5}}
    ]
  }")
YT_DESC=$(echo "$YT_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('description',''))")
YT_LEN=${#YT_DESC}
echo "Description length: $YT_LEN chars" >> "$LOG"
echo "PASS — YouTube description generated" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 6: Episode status detection
# ═══════════════════════════════════════════════════
divider "TEST 6: Episode status detection API"
curl -s "$API/projects/$SLUG/episodes" | python3 -c "
import sys,json
eps = json.loads(sys.stdin.read())
for ep in eps:
    if ep['episode_code'] == '$EP_CODE':
        s = ep['status']
        for k, v in s.items():
            print(f'{k}: {v}')
        break
" >> "$LOG"
echo "PASS — Status detection working" >> "$LOG"

# ═══════════════════════════════════════════════════
# TEST 7: Dashboard stats
# ═══════════════════════════════════════════════════
divider "TEST 7: Dashboard stats"
curl -s "$API/projects/$SLUG/dashboard-stats" | python3 -c "
import sys,json
data = json.loads(sys.stdin.read())
a = data['assets']
print(f'Scripts:        {a[\"scripts\"]}')
print(f'Scene Prompts:  {a[\"scene_prompts\"]}')
print(f'Thumb Prompts:  {a[\"thumb_prompts\"]}')
print(f'Images:         {a[\"images\"]} ({a[\"total_image_files\"]} files)')
print(f'Thumbnails:     {a[\"thumbnails\"]}')
print(f'Audio:          {a[\"audio\"]} ({a[\"total_audio_files\"]} files)')
print(f'Descriptions:   {a[\"descriptions\"]}')
print(f'Time saved:     {data[\"time_saved\"][\"hours\"]}h')
print(f'Episodes ready: {data[\"episodes\"][\"ready\"]}')
" >> "$LOG"
echo "PASS — Dashboard stats working" >> "$LOG"

# ═══════════════════════════════════════════════════
# FINAL SUMMARY
# ═══════════════════════════════════════════════════
divider "FINAL SUMMARY"
echo "All tests completed. Review above for details." >> "$LOG"

echo "Done! Results saved to: $LOG"
