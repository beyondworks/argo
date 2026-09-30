# Argo Office desktop

The desktop application bundles the same React UI as the web application. Mail API functions remain on the Office web server. Server secrets (`OFFICE_GOOGLE_CLIENT_SECRET`, `OFFICE_MAIL_KEY`) must never be bundled into the application.

## Local development

Install Office dependencies with `npm ci`. Set the public configuration below in an ignored `.env.local`, then run `npm run desktop:dev`. The development server uses port 5192 to avoid the existing Office servers.

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_OFFICE_WEB_ORIGIN`: the Office web service origin, with no path or credentials

## Review build

`npm run desktop:review` builds an unsigned/ad-hoc local macOS `.app` against a loopback Supabase. Put the public configuration in `.env.desktop-review.local`, or pass it as environment variables. The web API must be running separately. The local-only email/password form is enabled only in development or an explicit review build connected to loopback Supabase.

The artifact is `src-tauri/target/debug/bundle/macos/Argo Office.app` (unless `CARGO_TARGET_DIR` is set). Run this bundle directly; it does not replace an installed Argo or Messenger application.

## Production build

`npm run desktop:build` requires HTTPS web and Supabase origins. It builds the app without publishing or signing for distribution. Production web hosting, OAuth redirect configuration, migrations, signing/notarization and update distribution are separate release work. No updater endpoint is configured until Office has an approved release destination.

## Authentication and files

- Account sign-in uses the existing Messenger browser handoff protocol with an Office-branded loopback bridge. Supabase must permit `http://127.0.0.1:*/auth/paired` returns. The browser asks the user to confirm before transferring its session.
- Gmail keeps the registered web callback `/me/mail/connect`. A sealed desktop state routes the authorization code back to `argo-office://mail/callback`; the app accepts only its own pending request and user.
- Mail attachments use the OS save dialog. The app writes only the selected file; cancelling does not write a file.
- Shared links always use the web origin. External links open in the default browser; mail content cannot navigate the privileged app window.
- On macOS, closing the window hides the app; clicking its Dock icon restores it, and Cmd+Q quits. On Windows/Linux the last window closes the app. Background mail notifications are not implemented. Translation still requires a connected Argo runtime; the shell does not embed an agent runtime.

## Verification before release

Test on each target OS: fresh sign-in, denied/cancelled OAuth, Gmail reconnect, images and external links, attachment save/cancel, copy a public web link, edit then quit/relaunch, session restore, and translation via a connected Argo device. Local fake-provider tests do not establish real Google OAuth or installed-runtime behavior.
