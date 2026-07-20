#!/bin/bash
# Keeps the tracker dev server alive (restarting it if something kills it)
# until the playwright capture script completes, then shuts everything down.
cd /workspaces/8852f710-e7f5-4584-89dc-6a622c325283/templates/tracker || exit 1
LOG=tmp-logs/supervisor.log
: > "$LOG"
say(){ echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }

pids_matching(){ # $1 = substring of cmdline
  local out=""
  for d in /proc/[0-9]*; do
    local pid=${d#/proc/}
    local cmd
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
    case "$cmd" in *"$1"*) out="$out $pid";; esac
  done
  echo "$out"
}

kill_matching(){
  for pid in $(pids_matching "$1"); do
    [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null
  done
}

vite_alive(){
  [ -n "$(pids_matching 'vite/bin/vite.js')" ]
}

start_server(){
  : > tmp-logs/dev-sv.log
  # hold stdin open with a long-lived sleep piped in — vite exits on stdin EOF
  ( sleep 100000 | pnpm dev > tmp-logs/dev-sv.log 2>&1 ) &
  say "server wrapper started pid $!"
}

wait_for_boot(){ # wait for the migration smoke PASS line (server nearly ready)
  local i=0
  while [ $i -lt 45 ]; do
    if grep -q "PASS: migration smoke" tmp-logs/dev-sv.log 2>/dev/null; then
      say "boot marker seen after ~$((i*4))s"
      return 0
    fi
    sleep 4
    i=$((i+1))
  done
  say "boot marker not seen within 180s — proceeding anyway"
  return 1
}

say "supervisor start"
DEADLINE=$(( $(date +%s) + 2400 ))

for ATTEMPT in 1 2 3 4 5 6; do
  [ "$(date +%s)" -gt "$DEADLINE" ] && { say "global deadline hit"; break; }
  say "=== attempt $ATTEMPT ==="
  kill_matching 'vite/bin/vite.js'
  kill_matching 'agent-native.js dev'
  kill_matching 'sleep 100000'
  sleep 2
  start_server
  wait_for_boot
  sleep 3
  if node tmp-logs/capture.mjs > tmp-logs/capture.log 2>&1; then
    say "capture exited 0"
  else
    say "capture exited non-zero"
  fi
  if grep -q "CAPTURE_DONE" tmp-logs/capture.log 2>/dev/null; then
    say "CAPTURE_DONE confirmed"
    break
  fi
  say "capture incomplete — tail:"
  tail -5 tmp-logs/capture.log >> "$LOG" 2>/dev/null
done

say "cleanup: stopping dev server"
kill_matching 'vite/bin/vite.js'
kill_matching 'agent-native.js dev'
kill_matching 'sleep 100000'
kill_matching 'pnpm dev'
say "SUPERVISOR_DONE"
