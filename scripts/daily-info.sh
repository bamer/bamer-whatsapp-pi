#!/bin/bash
# Daily info script: weather, saying, pin-up

# Get weather for Vientiane
WEATHER=$(curl -s "https://wttr.in/Vientiane?format=j1" | python3 -c "
import json, sys
data = json.load(sys.stdin)
cc = data.get('current_condition', [{}])[0]
if cc:
    print(f\"Temp: {cc.get('temp_C', 'N/A')}°C\")
    print(f\"Desc: {cc.get('weatherDesc', [{}])[0].get('value', 'N/A')}\")
    print(f\"Humidity: {cc.get('humidity', 'N/A')}%\")
else:
    print('No weather data')
")

# Get saying of the day
SAYING=$(python3 -c "
import datetime
sayings = [
    'La vie est belle, mais pas gratuite. 🌸',
    'Celui qui n\'a rien à donner a tout à gagner. 🤝',
    'Le silence est parfois la meilleure réponse. 🤫',
    'Chaque jour est une nouvelle chance de changer sa vie. 🌅',
    'La patience est amère, mais son fruit est doux. 🍯',
    'Rien ne sert de courir, il faut partir à point. 🐌',
    'Petit à petit, l\'oiseau fait son nid. 🐦',
    'C\'est en forgeant qu\'on devient forgeron. 🔨',
    'Les petites pensées parlent beaucoup, les grandes peu. 💭',
    'La vie est un mystère qu\'il faut vivre, et non un problème à résoudre. ✨',
    'Le bonheur n\'est pas quelque chose de prêt à l\'emploi. Il vient de vos propres actions. 😊',
    'Ce que tu es crie si fort que je n\'entends pas ce que tu dis. 🗣️',
    'L\'expérience est un nom que l\'on donne à ses erreurs. 📚',
    'La seule limite à notre réalisation d\'aujourd\'hui sera nos doutes d\'aujourd\'hui. 🌟',
    'Il n\'y a qu\'une richesse, c\'est les hommes. 💎',
]
today = datetime.date.today()
day_of_year = today.timetuple().tm_yday
saying = sayings[day_of_year % len(sayings)]
print(saying)
")

# Fetch pin-up from PornPics
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" "https://www.pornpics.com/?q=skinny+girl+anal" -o /tmp/pinup-page.html
IMAGES=$(grep -oP 'href="\Khttps://[^"]*\.jpg' /tmp/pinup-page.html | sort -u)
RANDOM_IMAGE=$(echo "$IMAGES" | shuf -n 1)
curl -s -o /tmp/pinup-today.jpg "$RANDOM_IMAGE"

# Send message
echo "Sending daily info..."
echo "Weather: $WEATHER"
echo "Saying: $SAYING"
echo "Pin-up: /tmp/pinup-today.jpg"
