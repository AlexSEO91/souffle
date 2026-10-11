#!/bin/bash
# Assemble supabase/deploy/souffle-notify.ts (un seul fichier) en embarquant plan.js tel quel,
# pour que la notification calcule exactement comme l'app.
cd "$(dirname "$0")/.."
mkdir -p supabase/deploy
python3 - <<'PY'
src = open('supabase/functions/souffle-notify/index.ts').read()
marker = '// @@EMBED@@'
assert src.count(marker) == 1
plan = '// ─── plan.js (copie générée, ne pas modifier ici) ───\n' + open('plan.js').read()
open('supabase/deploy/souffle-notify.ts', 'w').write(src.replace(marker, plan))
print('supabase/deploy/souffle-notify.ts ok')
PY
