# CloudVault

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

**Real cloud upload powered by Puter.js v2.**

CloudVault is a premium, mobile-first web app that lets users upload images and videos directly to their **own Puter cloud storage** — no backend, no database, no API keys. Every upload, gallery item, and delete is a real cloud operation handled entirely in the browser via [Puter.js v2](https://js.puter.com/v2/).

After refreshing the page your files are still there, because they live in Puter — not in `localStorage` or browser memory.

---

## Features

- Real upload to Puter cloud storage (`puter.fs.write`)
- Real gallery loaded from the cloud (`puter.fs.readdir` + `puter.fs.read`)
- Real delete (`puter.fs.delete`)
- Multiple file uploads with per-file progress: `Uploading 1 of 3`, etc.
- Accepts only `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/webm`, `video/ogg`
- Unique filenames using `timestamp-random-original.ext` to prevent conflicts
- `createMissingParents: true` so the storage folder is created automatically
- Drag-and-drop or tap-to-pick file selection
- Real image previews and HTML5 video player with controls
- Stats: total files, images, videos
- Beautiful empty / loading / error states
- Premium glassmorphism dark UI with neon cyan + violet glow
- Fully responsive — works great on 360 / 390 / 412 / 430 px Android screens and on desktop

---

## Tech stack

- [Vite](https://vitejs.dev/) build tooling
- Vanilla JavaScript (ES modules)
- HTML + CSS
- [Puter.js v2](https://docs.puter.com/) for storage and auth
- No backend, no database, no API key

Storage folder used in the user's Puter drive: **`cloudvault-uploads`**

---

## Project structure

```
.
├── index.html
├── package.json
├── vite.config.js
├── README.md
└── src
    ├── main.js
    └── style.css
```

---

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open the URL printed by Vite (usually <http://localhost:5173>).

When you click **Upload**, Puter.js will ask you to sign in (free). Files are saved to your private Puter drive at `cloudvault-uploads/`.

---

## Build for production

```bash
npm run build
```

The production output is written to **`dist/`**.

To preview the production build locally:

```bash
npm run preview
```

---

## Deploy to Render (Static Site)

CloudVault is designed to deploy as a **Static Site** on [Render](https://render.com).

Use these settings:

| Setting             | Value                              |
| ------------------- | ---------------------------------- |
| Service type        | Static Site                        |
| Build Command       | `npm install && npm run build`     |
| Publish Directory   | `dist`                             |
| Node version        | 18 or newer                        |
| Auto-Deploy         | On push (recommended)              |

### Step-by-step

1. Push this repository to GitHub.
2. In the Render dashboard click **New → Static Site**.
3. Connect your GitHub repo.
4. Set:
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`
5. Click **Create Static Site**. Render will install dependencies, build the project, and serve the contents of `dist/`.
6. Open the deployed URL. Sign in to Puter when prompted, then upload your first image or video.

No environment variables, secrets, or API keys are required.

---

## How it works

When you select files and click **Upload**, the app calls:

```js
await puter.fs.write(`cloudvault-uploads/${uniqueName}`, file, {
  createMissingParents: true,
  overwrite: false,
});
```

On page load (and after every upload/delete), the gallery is rebuilt by calling:

```js
const entries = await puter.fs.readdir('cloudvault-uploads');
// for each entry:
const blob = await puter.fs.read(entry.path);
const url = URL.createObjectURL(blob);
```

Delete uses:

```js
await puter.fs.delete(entry.path);
```

If the storage folder does not exist yet, the app shows a friendly empty state instead of crashing. If the user is not signed in, the app shows:

> Please sign in to Puter to upload and manage your files.

---

## Security notes

- The app only previews files as `<img>` and `<video>` — uploaded files are never executed.
- All inserted file names use `textContent`, never `innerHTML`, to prevent XSS.
- File names are sanitized and prefixed with a timestamp + random ID before being written to the cloud.
- Files are stored inside the signed-in user's own Puter drive, scoped to the `cloudvault-uploads` folder.

---

## License

MIT — built as an example app on top of [Puter.js](https://puter.com).
