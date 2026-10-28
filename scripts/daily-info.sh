#!/bin/bash
# Daily info script: weather, saying, pin-up
set -u

# ---- meteo Vientiane (temperature, ressenti, condition, humidite, vent) ----
curl -s --max-time 45 "https://wttr.in/Vientiane?format=j1" -o /tmp/wttr-vientiane.json
WEATHER=$(python3 - <<'PY'
import json
try:
    data = json.load(open('/tmp/wttr-vientiane.json'))
except Exception:
    data = {}
cc = (data.get('current_condition') or [{}])[0]
desc = (cc.get('weatherDesc') or [{}])[0].get('value', 'N/A').strip()
print(f"Temp: {cc.get('temp_C', 'N/A')}°C (ressenti {cc.get('FeelsLikeC', 'N/A')}°C)")
print(f"Desc: {desc}")
print(f"Humidity: {cc.get('humidity', 'N/A')}%")
print(f"Wind: {cc.get('windspeedKmph', 'N/A')} km/h ({cc.get('winddir16Point', '')})")
PY
)

# ---- saying of the day (rotation sur le jour de l'annee) ----
SAYING=$(python3 - <<'PY'
import datetime
sayings = [
    'La vie est belle, mais pas gratuite. 🌸',
    "Celui qui n'a rien à donner a tout à gagner. 🤝",
    'Le silence est parfois la meilleure réponse. 🤫',
    'Chaque jour est une nouvelle chance de changer sa vie. 🌅',
    'La patience est amère, mais son fruit est doux. 🍯',
    'Rien ne sert de courir, il faut partir à point. 🐌',
    "Petit à petit, l'oiseau fait son nid. 🐦",
    "C'est en forgeant qu'on devient forgeron. 🔨",
    'Les petites pensées parlent beaucoup, les grandes peu. 💭',
    "La vie est un mystère qu'il faut vivre, et non un problème à résoudre. ✨",
    "Le bonheur n'est pas quelque chose de prêt à l'emploi. Il vient de vos propres actions. 😊",
    "Ce que tu es crie si fort que je n'entends pas ce que tu dis. 🗣️",
    "L'expérience est un nom que l'on donne à ses erreurs. 📚",
    "La seule limite à notre réalisation d'aujourd'hui sera nos doutes d'aujourd'hui. 🌟",
    "Il n'y a qu'une richesse, c'est les hommes. 💎",
]
day_of_year = datetime.date.today().timetuple().tm_yday
print(sayings[day_of_year % len(sayings)])
PY
)

# ---- pin-up PornPics ----
# - requete selon jour_de_l_annee % 10 (rotation)
# - TOUTES les URLs d'images cdni (pas seulement les href)
# - /460/ -> /1280/
# - jamais une photo deja envoyee (journal) + controle JPEG
PINUP_LOG=${PINUP_LOG:-/home/bamer/emu-work/pinup-sent.log}
PINUP_URL=$(python3 - <<'PYEOF'
import datetime, os, pathlib, re, subprocess, time
QUERIES = ['skinny+petite+asian', 'skinny+teen', 'anal+petite+asian', 'petite+chinese+beauty', 'asian+beauty',
           'petite+asian+double', 'skinny+brunette+beauty', 'petite+deep', 'petite+asian+facial', 'petite+asian+full']
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
doy = datetime.date.today().timetuple().tm_yday
# la requete du jour d'abord, puis les suivantes en repli si elle ne donne rien
for q in QUERIES[doy % len(QUERIES):] + QUERIES:
    # un cache par requete : on ne melange jamais les resultats de deux requetes
    page = pathlib.Path('/tmp/pinup-page-' + re.sub(r'[^a-z0-9]+', '-', q.lower()).strip('-') + '.html')
    stale = (not page.exists()) or page.stat().st_size < 1000 or (time.time() - page.stat().st_mtime) > 6 * 3600
    if stale:
        # -L indispensable : certaines requetes (ex. skinny+teen) repondent par une redirection 301
        subprocess.run(['curl', '-sL', '--max-time', '60', '-A', UA,
                        f'https://www.pornpics.com/?q={q}', '-o', str(page)], check=False)
    urls = sorted(set(re.findall(r'https://cdni\.pornpics\.com/[^"\'\s]*\.jpg', page.read_text(errors='ignore'))))
    if urls:
        break
urls = [u.replace('/460/', '/1280/') for u in urls]
log = pathlib.Path(os.environ.get('PINUP_LOG', '/home/bamer/emu-work/pinup-sent.log'))
seen = set()
if log.exists():
    seen = {l.split(' ', 1)[1].strip() for l in log.read_text().splitlines() if ' ' in l}
fresh = [u for u in urls if u not in seen]
pool = fresh or urls
print(pool[os.urandom(1)[0] % len(pool)] if pool else '')
PYEOF
)
if [ -n "$PINUP_URL" ]; then
  curl -s --max-time 90 -o /tmp/pinup-today.jpg "$PINUP_URL"
  if file /tmp/pinup-today.jpg | grep -q JPEG; then
    echo "$(date +%F) $PINUP_URL" >> "$PINUP_LOG"
  else
    echo "WARN: pin-up non-JPEG ($PINUP_URL)" >&2
  fi
fi

# Send message
echo "Sending daily info..."
echo "Weather: $WEATHER"
echo "Saying: $SAYING"
echo "Pin-up: /tmp/pinup-today.jpg"
echo "Pin-up URL: $PINUP_URL"
