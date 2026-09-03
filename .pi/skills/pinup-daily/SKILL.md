# Pin-up of the Day

Get a daily pin-up/glamour photo from PornPics and send it via WhatsApp.

## When to Use
- User asks for "pin-up du jour", "pinup", "photo du jour", "pin-up"
- User wants a daily glamour photo sent via WhatsApp
- Triggered by `/pinup` or natural language requests

## Procedure

### Step 1: Fetch Random Photo from PornPics

1. Use `curl` to fetch the PornPics search page:
```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" "https://www.pornpics.com/?q=skinny+girl+anal" -o /tmp/pinup-page.html
```

2. Extract image URLs from preload links and pick a random one:
```bash
# Get list of image URLs from preload links
IMAGES=$(grep -oP 'href="\Khttps://[^"]*\.jpg' /tmp/pinup-page.html | sort -u)

# Pick random one (different each time)
RANDOM_IMAGE=$(echo "$IMAGES" | shuf -n 1)

# Download it
curl -s -o /tmp/pinup-today.jpg "$RANDOM_IMAGE"
```

### Step 2: Verify Image

Check the downloaded file is actually an image:
```bash
file /tmp/pinup-today.jpg
# Should return: JPEG image data, ...
```

### Step 3: Send via WhatsApp

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
- Always pick a random image (use `shuf -n 1`)
- Verify the downloaded file is actually an image (`file /tmp/pinup-today.jpg`)
- If no images found, try a different search query

## Verification
- Confirm the image file exists and is > 10KB
- Verify WhatsApp media send succeeds
- Check that the message is delivered to the group
