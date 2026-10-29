# Keychat

A Claude chat app for an iPhone used like a laptop, with a Bluetooth or USB keyboard and optionally a trackpad or mouse. You can do everything from the keyboard: scroll slowly, jump between messages, switch models and chats, copy code, edit, and regenerate. You paste in your own Anthropic API key, and the app talks to `api.anthropic.com` directly. There is no server in between.

It's a static web app (three files plus icons). Host it anywhere, open it in Safari, and **Add to Home Screen**. It then opens full screen like a native app.

## Put it on your iPhone

The page has to be served over HTTPS. Pick one:

**Netlify Drop (about a minute, no account needed to try)**
1. On a computer, go to https://app.netlify.com/drop and drag the `keychat` folder onto the page.
2. Open the URL it gives you in **Safari** on the iPhone.

**GitHub Pages (free and permanent)**
1. Create a repository, then upload `index.html`, `app.js`, `styles.css`, `manifest.webmanifest` and the `icons/` folder.
2. Go to **Settings → Pages → Deploy from branch → main / root**.
3. Open `https://<you>.github.io/<repo>/` in **Safari** on the iPhone.

Then, in Safari: **Share → Add to Home Screen → Add**. Launch Keychat from the home screen and paste your API key (get one at https://console.anthropic.com/settings/keys).

> Your key is saved in that browser's storage on that phone only. It is never put in the code you host, so a public repository or URL is fine. Anyone holding your unlocked phone could use the app, though, so set a monthly spend limit in the Anthropic Console.

## Two modes, like a laptop

The status bar shows which mode you're in.

- **TYPE**: the cursor is in the message box. `↵` sends and `⇧↵` adds a new line.
- **READ**: press `Esc` (or `⌃[`). Now single keys move around the conversation the way a laptop's keys move around a page. Press `i` or `↵` to go back to typing.

### iPhone keyboard tips
- **No Esc key?** `⌃[` does the same thing. Or remap Caps Lock: **Settings → General → Keyboard → Hardware Keyboard → Modifier Keys → Caps Lock → Escape**.
- Run Keychat from the home-screen icon. In plain Safari, a few `⌘` shortcuts belong to Safari itself.

## Shortcuts

**Anywhere**

| Keys | Action |
|---|---|
| `⌘K` | Command palette: search every action, model, effort level and chat |
| `⌘J` | Chat switcher (press again to move down, `↵` to open) |
| `⌘⇧O` | New chat |
| `⌘.` | Stop generating |
| `⌘⇧S` | Show / hide the chat list |
| `⌘/` · `⌘,` | Shortcut help · Settings |
| `⌥↑` `⌥↓` | Previous / next chat |
| `⌃1`…`⌃4` | Pick model: Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 |

**READ mode**

| Keys | Action |
|---|---|
| hold `↓` / `↑` | **Glide scroll**: smooth, slow, continuous (add `⇧` for 3×) |
| `−` / `=` | Slower / faster glide (7 speeds) |
| `s` | **Auto-scroll** (teleprompter); follows the answer while it streams |
| `Space` / `⇧Space` | Page down / up |
| `d` / `u` | Half page down / up |
| `g` / `G` | Top / bottom |
| `j` / `k` | Next / previous message |
| `y` / `Y` | Copy message / copy its last code block |
| `o` | Open / close that message's thinking |
| `e` | Edit the selected (or last) message, then resend |
| `r` | Regenerate the last reply |
| `n` | New chat |
| `[` / `]` | Previous / next chat |
| `b` | Chat list (`↑↓` or `j/k`, `↵` open, `x` delete) |
| `m` / `M`, `1`–`4` | Cycle model / pick a model |
| `t` / `T` | More / less thinking effort (low → max) |
| `v` | Show / hide thinking summaries |
| `Esc` | Stop generating, stop auto-scroll, or clear the selection |
| `?` | All shortcuts |

On an empty message box, `↑` jumps you into READ mode on the last message.

Every action also works by touch or trackpad. Tap the status-bar chips to change mode, model, effort or scroll speed, or tap ⌘ in the top bar for the palette.

## What it sends to Claude

- Default model **Claude Opus 5.5**. Switch any time; each reply shows the model that wrote it.
- Replies stream in, using adaptive thinking with **summarized thinking** shown in a collapsible block. **Effort** (low, medium, high, xhigh, max; default medium) controls how hard it thinks.
- The full conversation is sent back each turn, including thinking blocks unchanged, as the API requires. Prompt caching is on, which makes long chats cheaper.
- **Refusal fallback is on** for Opus, Sonnet and Fable (`fallbacks: "default"`). If a safety classifier declines a request, the API retries it on Anthropic's recommended fallback model and the reply says so. Haiku has no server-side fallback. To turn it off, delete the `if (modelInfo(model)?.fallbacks)` block in `app.js`.
- Each reply shows token counts and a **rough** cost estimate. Your Anthropic Console has the real numbers.

Chats are stored in the browser on your device. Settings → *Delete all chats* wipes them.

## Optional: a Siri / Action-button Shortcut

For one-off questions without opening the app, build this in the **Shortcuts** app:

1. **Ask for Input** (Text). Prompt: `Ask Claude`
2. **Get Contents of URL**
   - URL: `https://api.anthropic.com/v1/messages`
   - Method: `POST`
   - Headers: `x-api-key` = *your key*, `anthropic-version` = `2023-06-01`, `content-type` = `application/json`, `anthropic-beta` = `server-side-fallback-2026-07-01`
   - Request Body: **JSON**
     - `model` (Text): `claude-opus-5-5`
     - `max_tokens` (Number): `16000`
     - `fallbacks` (Text): `default`
     - `output_config` (Dictionary): `effort` (Text) = `low`
     - `messages` (Array) → one Dictionary: `role` (Text) = `user`, `content` (Text) = *Provided Input*
3. **Get Dictionary Value**: `content` from *Contents of URL*
4. **Get Item from List**: *Last Item*. Opus 5.5 always thinks first, and the answer text is the last block.
5. **Get Dictionary Value**: `text`
6. **Show Result**

Name it "Ask Claude" to trigger it with Siri, or assign it to the Action button.

## Files

```
index.html            markup, import map (pinned CDN versions of the Anthropic SDK, marked, DOMPurify)
app.js                all the logic: keyboard modes, glide-scroll engine, palette, streaming, storage
styles.css            light/dark theme, iPhone safe areas, layout
manifest.webmanifest  home-screen app metadata
icons/                app icons
```

To try it on a computer: `python3 -m http.server` in this folder, then open http://localhost:8000.
