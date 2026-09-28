# YoqArt — Cloudflare Login + My Documents

This build adds optional YoqArt accounts using Cloudflare Pages Functions, D1 and R2.

## What is included
- Signup, login and logout
- Email verification
- Forgot/reset password
- Secure PBKDF2 password hashing
- HttpOnly session cookies
- My Documents
- Save generated Invoice, Payslip, Credit Note and Debit Note as PDFs to R2
- Download/delete saved documents
- D1 stores account/session/document metadata; R2 stores PDF files
- Existing YoqArt UI, SEO, Adsterra and tools are preserved

## Cloudflare setup
1. Pages project: `yoqart`
2. D1 database: `yoqart-db`
3. R2 bucket: `yoqart-files`
4. In Pages > Settings > Bindings add:
   - D1 database binding variable `DB` -> `yoqart-db`
   - R2 bucket binding variable `BUCKET` -> `yoqart-files`
5. Run `schema.sql` against `yoqart-db` once.
6. Add a secret `RESEND_API_KEY` for email delivery.
7. Add a variable `AUTH_FROM_EMAIL` such as `YoqArt <noreply@yoqart.in>` after the sending domain is verified with your email provider.
8. Deploy with Wrangler or Git. Cloudflare Pages dashboard Direct Upload does not deploy Pages Functions.

## Wrangler
From the project root:
`npx wrangler pages deploy public --project-name yoqart`

If using a Git repository, connect the repository to the existing Pages project and deploy from the repository root. The `functions/` directory must be at the project root and `public/` is the Pages output directory.

## Important
Do not put API keys, passwords, or Cloudflare account tokens in this ZIP or in frontend JavaScript.

## Native processing backend (required for 5 server tools)
Cloudflare Pages cannot run Ghostscript, yt-dlp or the Python PDF conversion stack used by `server.js`. Deploy the repository's Dockerfile to Render, Railway, Fly.io or another container host.

After the backend is live, add this Cloudflare Pages environment variable:
- `PROCESSING_API_URL` = the HTTPS base URL of the deployed YoqArt backend, for example `https://yoqart-processing.example.com`

The Pages Function at `/api/processing/*` proxies the five processing endpoints to that backend. The browser continues to call YoqArt's same-origin `/api/processing/...` URLs.


## Feedback and Contact configuration
- Run the updated `schema.sql` against D1. It adds `contact_inquiries` and `api_rate_limits`.
- The APIs are `/api/v1/contact` and `/api/v1/feedback`.
- Email delivery uses the existing Resend setup (`RESEND_API_KEY` and `AUTH_FROM_EMAIL`).
- Contact emails are sent to `contact@yoqart.in` with the visitor's email as Reply-To. Feedback is sent to `feedback@yoqart.in`.
- Rate limiting is stored in D1: 5 submissions per IP per 10 minutes for each public form.
- For production CAPTCHA protection, configure `RECAPTCHA_SECRET_KEY`; the frontend accepts a reCAPTCHA token as `recaptchaToken`. Set `RECAPTCHA_MIN_SCORE` if desired (for example `0.5`). Also add your reCAPTCHA site-key/token generation to the frontend before enabling the secret.
- Never place `RECAPTCHA_SECRET_KEY` in frontend JavaScript.
