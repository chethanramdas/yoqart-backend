# YoqArt Full-Stack Deployment

## GitHub
Upload the contents of this folder to the root of a GitHub repository. Keep `server.js`, `package.json`, and `Dockerfile` at the repository root and `public/index.html` inside `public/`.

## Render
1. Render → New → Web Service.
2. Connect the GitHub repository.
3. Runtime: Docker.
4. Dockerfile: `./Dockerfile`.
5. Create the service.
6. Test `https://YOUR-RENDER-SERVICE.onrender.com/api/health`.

## Cloudflare
Keep your website on Cloudflare Pages if desired. Route `/api/*` from your domain to the Render backend using a Cloudflare Worker/reverse proxy. The frontend already calls `/api/download`, so no Render URL needs to be hard-coded into the browser.

## Usage
Use the media downloader only for content you own or are authorized to download and follow source-platform terms.
