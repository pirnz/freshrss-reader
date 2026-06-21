# Read Aloud (TTS) — FreshRSS extension

Adds a **read-aloud** control to every article in FreshRSS. It uses the
browser's built-in [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API)
(`window.speechSynthesis`) — no external service, no API key, nothing leaves
the browser.

## Features

- ▶ / ⏸ play & pause, ⏹ stop, on each article header.
- Voice picker (all voices the browser/OS exposes) and a speed selector
  (0.5×–2×). Both choices are remembered in `localStorage`.
- Long articles are split into small chunks so Chrome/Android does not cut
  off utterances at their ~15 s / ~200 char limit.
- Pause is implemented via `cancel()` + restart-from-current-chunk, which is
  reliable on Android where native `pause()`/`resume()` is not.
- Works with dynamically loaded articles (a `MutationObserver` attaches the
  control to articles added after page load).
- Optional **SSML** mode (emphasis / breaks / prosody) for engines that honour
  it, e.g. Apple voices on Safari/macOS. Off by default — see Configuration.

## Install

1. Copy the `xExtension-ReadAloud` folder into your FreshRSS `extensions`
   directory:

   ```
   FreshRSS/extensions/xExtension-ReadAloud
   ```

   With Docker, mount it:

   ```bash
   docker run ... -v /path/to/xExtension-ReadAloud:/var/www/FreshRSS/extensions/xExtension-ReadAloud ...
   ```

2. In FreshRSS go to **Settings → Extensions**, find **Read Aloud (TTS)** and
   enable it. It is a `user` extension, so each account enables it
   individually.

3. Open any article — the controls appear in the article header.

## Configuration

The only tunable is the **SSML** flag at the top of
`static/main.js`:

```js
const SSML = false;   // true = build SSML markup, false = plain text
```

- `false` (default): plain text. Safe for every engine, including Google
  voices which would otherwise read the markup tags out loud.
- `true`: wraps the text in SSML (`<emphasis>`, `<break>`, `<s>`). Useful only
  with engines that support it (Apple voices on Safari/macOS). Edit the file
  and reload.

## Requirements

- FreshRSS with extension support.
- A browser that implements the Web Speech API (Chrome, Edge, Safari, and
  Chrome on Android; Firefox needs speech voices installed at the OS level).
- Voice availability depends on the operating system / browser, not on this
  extension.

## How it works

`extension.php` registers the two static assets on every page:

```php
Minz_View::appendStyle($this->getFileUrl('main.css', 'css'));
Minz_View::appendScript($this->getFileUrl('main.js', 'js'));
```

Everything else is client-side. `static/main.js` finds each `<article>`,
extracts the body text (`.text` / `.flux_content`, stripping buttons,
scripts, nav, and existing controls), chunks it, and feeds the chunks to a
single shared `speechSynthesis` player so only one article speaks at a time.

## Files

```
xExtension-ReadAloud/
├── metadata.json      extension manifest (name, entrypoint, version, type)
├── extension.php      registers the static assets
├── README.md          this file
└── static/
    ├── main.js        the read-aloud logic
    └── main.css       control styling (responsive; stacks on mobile)
```

## License

Provided as-is for use with FreshRSS.
