# Pin-up of the Day

Get a daily pin-up/glamour photo from PornPics and send it via WhatsApp.

## When to Use

- User asks for "pin-up du jour", "pinup", "photo du jour", "pin-up"
- User wants a daily glamour photo sent via WhatsApp
- Triggered by the `daily-info-ben` cron job at 08:00

## Procedure

### Step 1: Choose Rotating Query

1. Calculate day of year and select query from rotating pool:

```bash
# 10 rotating queries (day of year % 10 selects one)
QUERIES=("skinny+petite+asian" "skinny+teen" "anal+petite+asian" "petite+chinese+beauty" "asian+beauty" "petite+asian+double" "skinny+brunette+beauty" "petite+deep" "petite+asian+facial" "petite+asian+full")
QIDX=$(( $(date +%j) % 10 ))
QUERY="${QUERIES[$QIDX]}"
```

1. Fetch the PornPics search page with the EXACT selected query:

```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" "https://www.pornpics.com/?q=$QUERY" -o /tmp/pinup-page.html
```

### Step 2: Extract ALL Image URLs and Pick Random

1. Extract ALL `cdni.pornpics.com` URLs from the full HTML (not just href links):

```bash
# Extract every cdni.pornpics.com URL, deduplicate, pick one at random
RANDOM_IMAGE=$(grep -oP 'https://cdni\.pornpics\.com/[^"'"'"' ]*\.jpg' /tmp/pinup-page.html | sort -u | shuf -n 1)
```

1. Upgrade to high resolution (1280px instead of 460px):

```bash
HIGH_RES="${RANDOM_IMAGE/\/460\//\/1280\/}"
curl -s -o /tmp/pinup-today.jpg "$HIGH_RES"
```

### Step 3: Verify Image

Check the downloaded file is actually an image:

```bash
file /tmp/pinup-today.jpg
# Should return: JPEG image data, ...
```

### Step 4: Send via WhatsApp

Use the `send_wa_media` tool:

```
send_wa_media({
  jid: "120363409409770410@g.us",
  mediaPath: "/tmp/pinup-today.jpg",
  type: "image",
  caption: "📸 Pin-up du jour ! 🌺"
})
```

## Pitfalls

- Always use user agent `-A "Mozilla/5.0"` or PornPics may block
- Extract ALL `cdni.pornpics.com` URLs (not just `href` links) — gives 20+ images per page
- Always pick a random image with `shuf -n 1` — ensures variety
- Always upgrade `/460/` to `/1280/` for high resolution
- Verify the downloaded file is actually an image (`file /tmp/pinup-today.jpg`)
- The 10 queries rotate daily (day of year % 10) — one query per day of the cycle

## Verification

- Confirm the image file exists and is > 10KB
- Verify WhatsApp media send succeeds
- Check that the message is delivered to the group
- Verify 20+ URLs were extracted from the page (ensures variety)
