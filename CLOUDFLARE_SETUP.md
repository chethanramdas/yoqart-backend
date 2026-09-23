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
