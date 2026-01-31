#!/bin/bash
# Quick progress check for code reviews
echo "════════════════════════════════════════════"
echo "  CODE REVIEW PROGRESS"
echo "════════════════════════════════════════════"
echo ""
echo "📊 Stories with fix commits:"
git log --oneline --since="2025-01-31 09:00" | grep -i "fix code review" | while read line; do
  echo "  ✓ $line"
done
echo ""
FIXED=$(git log --oneline --since="2025-01-31 09:00" | grep -i "fix code review" | wc -l | tr -d ' ')
echo "📈 Progress: $FIXED of 11 stories reviewed"
echo ""
echo "🔄 Active process:"
ps aux | grep "claude" | grep -v "Claude.app" | grep -v grep | grep -v "1512" | head -1 | awk '{print "   Claude PID " $2 " running since " $9}'
echo ""
echo "🧪 Tests: $(npm test 2>&1 | grep "Tests" | head -1)"
