# Running GradeScan on your phone with "Continue with Google"

Teachers open the app, tick **I agree** to the Terms of Use and Privacy Notice, tap **Continue with Google** and approve Google's one permission screen, which asks for their **name and e-mail address** and for Google's per-file **Drive** permission (so the attendance mode can create new sheets in the teacher's own Drive; it reaches only the files GradeScan itself creates). Then they paste the link of **one** sheet, and that sheet alone is what GradeScan opens. GradeScan never gets access to the teacher's other sheets or the rest of their Drive. (The Drive line can be unticked on Google's page: sign-in then still works, but the app has no other place to ask for it, so *creating a new Google Sheet* is then refused until the teacher signs out and signs in again with the line ticked; see Parts 3 and 5.) This file is the one-time setup for whoever runs the backend.

```
Phone (Expo Go)  ──Wi-Fi──▶  your PC (backend)  ──▶  Gemini (OCR)
      │                              │
      │                              └──▶ Google Sheets, as GradeScan's own "robot" Google account
      └── Google sign-in page ──▶ a tiny static page on GitHub Pages (callback.html) ──▶ back into the app
```

How sheets work, in one paragraph. The backend has its own Google account for Sheets, a **service account** (the "robot", Part 2). To use a sheet, the teacher pastes its link into the app. To **save grades** into it, the teacher shares that one sheet with the robot's e-mail address as **Editor** (the app shows the address and says so; it is the same step as sharing with a colleague, and once per sheet). To only **read** a sheet, "Anyone with the link can view" is enough. The teacher's own Google sign-in is **not used** for reading, analysing or saving; it only tells the app who the teacher is. (The attendance mode's *new Google Sheet* option is the one place the teacher's own Google permission is used: it creates the sheet in the teacher's Drive, which then belongs to the teacher; the robot is added as Editor so later days can be ticked.)

Why the extra page on GitHub Pages: Google only lets a sign-in return to an **https** address (not a PC's `http://192.168…` address). The page is free, needs no card and contains no secrets; it only hands the one-time sign-in code back to the app, and the app finishes the sign-in with your backend.

The backend stays on your PC (as it already is for scanning), so **the PC must be on and the phone on the same Wi-Fi** whenever someone scans or syncs. Want it available all the time? See *Part 6 — a cloud server instead of the PC*.

---

## Part 1 — the return page on GitHub Pages (5 minutes)

1. On GitHub create a **new repository** named `gradescan-auth`, set it to **Public** (free GitHub Pages needs a public repository), and tick *Add a README file* so it is not empty.
2. In that repository click **Add file → Upload files**, drag in `auth-relay/callback.html` from this project, and click **Commit changes**. (It brings the teacher back after signing in.)
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save.**
4. Wait about a minute, then open
   `https://<your-github-name>.github.io/gradescan-auth/callback.html`
   (for example `https://moha880.github.io/gradescan-auth/callback.html`). It should say **"Cannot sign in from here"**. That is correct: it only works when Google sends you to it.
5. Write that address down. It is your **return address** and must be copied exactly (including `https://` and `.html`) into Google Cloud (Part 3) and into `backend/.env` (Part 4).

The page holds no secret. `callback.html` accepts only app links (`exp://` for Expo Go and `gradescan://` for the installed app), so it cannot be abused to send people to a website. If you ever change `"scheme"` in `mobile/app.json`, add the new scheme to the `APP_SCHEMES` list at the top of the script in `callback.html` and upload the file again.

If you used an earlier version that had a `picker.html` page in the same repository, you can delete that file on GitHub; it is not used any more.

**Whenever `auth-relay/callback.html` changes**, upload it again the same way (*Add file → Upload files*, same name; GitHub replaces the old one), wait about a minute, and open the page address once in the phone's browser. A page that loads with nothing after `callback.html` in the address bar should say **"Cannot sign in from here"**. Then close every old white *Almost done* page in Chrome / Samsung Internet (tab list → close all) so no old copy is left running.

## Part 2 — the robot account that opens the sheets (5 minutes, once)

This is a Google *service account*: an account that belongs to GradeScan, not to a person. It is what reads and writes the sheets that teachers share with it. Do this in the Google account that runs the backend.

1. Open https://console.cloud.google.com and create (or pick) a project, e.g. *GradeScan*. Use the same project for Part 3.
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable** (free). Then do the same for **Google Drive API** (also free). The Drive API is used only by the attendance mode's *First time → New Google Sheet* option (GradeScan creates the sheet in the teacher's own Drive, using the teacher's own permission, and adds the robot as Editor); grading and ticking a sheet that already exists work without it. (The robot itself asks Google only for the **Sheets** permission.)
3. **IAM & Admin → Service Accounts → Create service account.** Name it `gradescan-robot` (any name is fine) → **Create and continue**. Skip the two optional steps about roles and access (no role is needed) → **Done**.
4. Click the new account in the list → **Keys** tab → **Add key → Create new key → JSON → Create**. A `.json` file is downloaded to your PC.
5. Move that file into the `backend` folder and rename it **`service-account.json`**.
6. **Treat that file like a password.** Never e-mail it, paste it in a chat, or upload it to GitHub (the Docker build already leaves it out of the image). If it ever leaks, delete the key in the same Keys tab and create a new one.
7. Start the backend (Part 4). The log must say `Google Sheets: READY (account gradescan-robot@….iam.gserviceaccount.com)`. That e-mail is the one teachers share their sheet with. The app shows it to them (in the box on the Connect screen, and under **Settings → TEST**).

Hosting the backend somewhere you cannot upload a file to? Paste the whole JSON as ONE line into the variable `GOOGLE_SERVICE_ACCOUNT_JSON` instead (see `backend/.env.example`).

## Part 3 — "Continue with Google" in Google Cloud (about 10 minutes, once)

1. In the same project: **OAuth consent screen** (newer consoles call it *Google Auth Platform*, with the pages Branding, Audience, Data Access and Clients):
   - App name *GradeScan*, your e-mail as support and developer contact.
   - Audience / user type: **External**.
   - Data Access → **Add or remove scopes** → the list must contain exactly these four: `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile` (*see your e-mail address and your name*), plus `.../auth/drive.file` (*See, edit, create, and delete only the specific Google Drive files that you use with this app*). The sign-in asks for all four on the same Google page. **Remove `.../auth/spreadsheets` if it is still listed** (an earlier version used it; it is not used for teachers any more). Save.
2. **Credentials → Create credentials → OAuth client ID → Application type: Web application.** Under **Authorized redirect URIs → Add URI** paste your return address from Part 1:
   ```
   https://<your-github-name>.github.io/gradescan-auth/callback.html
   ```
   Create, then copy the **Client ID** and the **Client secret**. (No "Authorized JavaScript origins", no API key and no Picker API are needed.)

What teachers will see, and Google's rules for it (as Google's help page for the consent screen says at the time of writing; check it if something differs):

- **One permission screen at sign-in.** It asks for the name and e-mail and, as a separate line the teacher may untick, *See, edit, create, and delete only the specific Google Drive files that you use with this app*. It never mentions Sheets in general.
- **The Drive line is part of the sign-in, not a step in the middle of the work.** Google classes this per-file permission as **non-sensitive** (it cannot see the rest of the Drive), so it needs no security review. The app keeps the permission for creating sheets (same token as the sign-in) and uses it only for *First time → New Google Sheet*. **There is no "Allow Google Drive" button or link anywhere in the app.** Google's sign-in page is the only place the permission is asked. If the teacher unticks the line, or signed in with an earlier version, the app says so (an alert at sign-in: *Sign in again* / *Continue without Drive*; a status line on the first-time screen; in Settings), and the way to give it later is **Settings → SIGN OUT, then Continue with Google again with the Drive box ticked**.
- **Google's publishing rules.** While the consent screen is in **Testing** status, Google lets only the people listed under **Audience → Test users** (up to 100) give a permission beyond name and e-mail, and it ends a permission after 7 days. Because the Drive line is now on the sign-in page, this means: **add the Gmail address of every teacher under Test users**, or switch the **Publishing status** to **In production** (the Audience page offers it; the console tells you whether Google still asks for anything). In *Testing* the 7-day limit also ends the teacher's sign-in/Drive permission after a week: the teacher then has to sign in again (sign out, then Continue with Google) before the next new sheet can be created; the review screen offers **SAVE THE LIST IN THE APP INSTEAD** so no scanned names are lost. Publishing the app removes this. If a teacher sees *Access blocked … access_denied* on the sign-in page, they are not on the Test users list yet.
- Google never gives GradeScan the teacher's password. The app keeps a revocable token on the phone that is useless without your server's client secret; teachers can remove access any time at https://myaccount.google.com/permissions or with **Sign out** in the app.
- The consent screen shows the address the sign-in returns to (`<your-github-name>.github.io`). To show a nicer name and your own links there, fill in the **Branding** page (app name, support e-mail, privacy policy and terms links).

## Part 4 — the backend on your PC

1. In `backend`, copy `.env.example` to `.env` (if you do not have a `.env` yet) and open `.env` in Notepad. **Type the values yourself; never paste keys into a chat or e-mail.** Set:
   ```
   GEMINI_API_KEY=<a NEW key from https://aistudio.google.com/apikey>
   GOOGLE_OAUTH_CLIENT_ID=<Client ID from Part 3>
   GOOGLE_OAUTH_CLIENT_SECRET=<Client secret from Part 3>
   GOOGLE_REDIRECT_URI=https://<your-github-name>.github.io/gradescan-auth/callback.html
   ```
   The robot's key file from Part 2 (`backend/service-account.json`) needs no line in `.env`. `APP_API_KEY` is not needed while the backend is only on your home/school network.
2. Build and start it:
   ```powershell
   cd backend
   npm run build
   npm start
   ```
   The log must say **both** of these:
   - `Google sign-in: ENABLED` and the redirect address, which must be identical to the one you registered in Google Cloud.
   - `Google Sheets: READY (account …)`.

   If Windows asks whether to allow Node.js through the firewall, allow it for **private networks**.
3. Check: open http://localhost:3000/health in the PC's browser → `"status":"ok"`.

## Part 5 — the phone (Expo Go)

1. On the PC: `cd mobile`, `npm install`, then `npx expo start -c`. The phone must be on the **same Wi-Fi** as the PC.
2. Open **Expo Go** and scan the QR code. The app finds the backend by itself (`http://<PC address>:3000`); leave **Settings → Backend URL** empty.
3. **Settings → TEST** should say *Connected*, *Continue with Google: ready (name, e-mail and Drive for new attendance sheets)*, *Saving to Google Sheets: ready*, and then *Share each Google Sheet (Editor) with:* followed by the **robot's e-mail**.
4. The app opens on the **sign-in page**, which is the only way in. Read the **Terms of Use** and **Privacy Notice** (the two blue links; they open inside the app, in English or Arabic), **tick the box**, then tap **CONTINUE WITH GOOGLE**, pick the account and allow what Google asks (name, e-mail and the Google Drive line that lets GradeScan create attendance sheets in your own Drive; leave it ticked). The agreement is saved on the phone before Google opens, so the app is never entered without it. The browser then shows a white page that opens the app by itself; if it does not, tap **Open GradeScan** on that page. (There is no "copy the link" step and no box to paste anything: that backup was removed.)
   **Continue without an account (offline)** on the same page lets someone try the scanner without Google (same agreement). Classes that already existed on the phone (the guest's, or those of older e-mail/password accounts from earlier versions) move into the **first Google account that signs in**; a Google account's own classes are never touched.
5. Add a class: **Connect → Google Sheets**, paste the sheet's link and tap **ANALYZE SPREADSHEET**. The app then works without any Google session of the teacher:
   - If the sheet is **shared with the robot e-mail** (Editor), it is read and the grades can be saved into it.
   - If it is only shared as **"Anyone with the link can view"**, it is still read, and a notice titled *Share the sheet to save grades* explains that saving needs the sheet shared with the robot e-mail. The box on the Connect screen shows that e-mail (touch and hold it to copy).
   - If it is private and not shared with the robot, the app says so and shows the e-mail to share it with.

   To share: open the sheet in Google Sheets → **Share** → paste the robot's e-mail → **Editor** → **Send**. Do this once per sheet. (Setting a sheet to *"Anyone with the link can edit"* is **not** enough for saving: the robot is a separate account and has to be added by e-mail.)
6. After updating from an earlier version that used the Sheets permission for the sign-in, nothing has to be redone on the phone. Teachers who signed in before keep working (their old token is simply not used for sheets any more) and are asked to accept the updated Terms once.
7. **Attendance mode** (new). One extra dependency is needed once: in `mobile` run `npx expo install expo-sharing` (it lets the phone hand over the Excel file; without it everything else still works and the app tells you what to run), then `npx expo start -c`.

### Attendance mode: ticks in front of the names

Home has two cards: **SCAN GRADES** (exam papers: names and marks go into the grade sheet) and **TAKE ATTENDANCE** (a list of names: a ✓ goes in front of everyone present). For attendance, tap **TAKE ATTENDANCE**. The app only reads the names on the photo (no grades), matches them to the class list, and puts a ✓ for everyone who is there. Absent students are left empty; nothing is ever overwritten.

- **I already have a sheet.** Paste the link of the online Google Sheet (shared with the robot e-mail as **Editor**, exactly as in step 5), pick the worksheet and the column that holds the names, then pick the **column for the ticks**: any column that is already in the sheet, or **+ NEW COLUMN** (its title defaults to today's date, e.g. `2026-10-29`). Photograph the attendance paper (one photo per page; several pages are merged and a student who appears on two pages is flagged), review the list (tap a row to flip present/absent, assign an unmatched name to a student, add or remove a name), and tap **SAVE**. The ticks are written into the sheet's empty cells in that column only. A cell that already holds something is left untouched and counted in the result. The class is saved, so next time **TAKE ATTENDANCE** goes straight to the camera for the same sheet.
  - If the robot can read the sheet but not write into it (shared as "Anyone with the link can view" only), the app shows the robot's e-mail and a **CHECK AGAIN** button instead of continuing.
  - If you pick a *new* column letter whose cell already has a different title, the app refuses and asks you to choose that column from the list (so a day's column is never silently renamed).
- **First time (no sheet yet).** Give the class a name and choose where it lives:
  - **New Google Sheet.** The Drive permission was already given on Google's page when the teacher signed in (there is no extra permission step or button in the middle of the work; without it the first-time screen says so and the list can be kept *Only in the app*, see Part 3). The teacher scans the names, and GradeScan creates the sheet (names in column A, the first day in column B) **inside the teacher's own Google Drive**. The sheet belongs to the teacher: it counts against *their* Drive space and they can rename, move or share it like any other file. GradeScan's robot is added to it as **Editor** automatically so the next days can be ticked from the app. If that step fails the sheet still exists and the result card shows the robot's e-mail to add by hand (Share → Editor). Needs the Google Drive API (Part 2, step 2) and the `drive.file` scope plus the teacher on the Test users list (Part 3). A teacher who is signed in as an offline guest has no Google permission and can only use *Keep it inside the app + Excel*.
  - **Keep it inside the app + Excel (.xlsx) export.** Nothing goes online. Every day is saved on the phone; **EXPORT EXCEL** on the Attendance page (or the class card) builds a workbook (one row per student, one column per day with ✓, and a Total column) and opens the phone's share sheet.

  Either way the names on the first photo become the class list; later days are matched against it.
- Matching uses the same rules as grading: 85 % and above is marked present by itself, 65–84 % is shown for review, anything lower stays unmatched until you assign or add it.

### The terms text and when people are asked again

The Terms of Use and Privacy Notice (English and Arabic) live in `mobile/src/legal/index.ts`, and the sign-in page names **Eng Atta** as the maker. Before real teachers use the app:

- Fill in `CONTACT_EMAIL` in that file (the line "Questions? Write to …" stays hidden while it is empty).
- Have the text read by someone who knows the rules where the app is used. It is a plain-language draft, not legal advice, and some statements (the server keeps no photos, nothing is sold, no ads, GradeScan uses its own Google account for sheets) describe how *your* server is set up; keep them true or change them.
- When you change the text in a way that matters, change `TERMS_VERSION` in the same file (it is a date): every teacher is then asked to agree again the next time the app starts. Their acceptance (version and time) is stored on the phone in the `AppSettings` table.

## Part 6 — a cloud server instead of the PC (optional)

Only needed if the app must work without your PC being on. Any host that gives the backend an **https** address works (`backend/Dockerfile` builds it; `backend/render.yaml` is a ready blueprint for Render). **The step-by-step for a free Render server plus an Android app that anyone can install from a link is in `PUBLISH.md`.** Note that several hosts ask for a payment card (Render did when this was first set up; `PUBLISH.md` says what to do if it asks again).

- On a host with its own https address you do **not** need the GitHub Pages page: set `PUBLIC_URL=https://your-host`, leave `GOOGLE_REDIRECT_URI` empty, register `https://your-host/auth/google/callback` in Google Cloud, and the server's own page returns the teacher to the app.
- Give the host the robot's key as the one-line variable `GOOGLE_SERVICE_ACCOUNT_JSON` (Part 2), since you cannot put a file there.
- Set `APP_API_KEY` (20+ random characters) so strangers cannot use your Gemini quota or write into sheets shared with the robot, and put the same value in the app (Settings → Access key, or `mobile/app.json` → `extra.apiKey`; the address goes in `extra.backendUrl`). Treat that key as a door lock for your school, not as a secret.
- Free hosts usually sleep when idle (the first request then takes about a minute).
- Serve it over https; Android blocks plain `http://` in installed (non-Expo Go) builds.

To get rid of Expo Go too, build an installable Android app later with EAS (`eas build -p android --profile preview`); sign-in works there as well (the app's link scheme is `gradescan`).

## Things to know

- **Who can touch what.** The robot can open only the sheets somebody shared with it, and it can be removed from a sheet at any time (Share → remove). Anyone who can use your backend can ask it to open any sheet that has been shared with the robot, which is why `APP_API_KEY` matters on a public host.
- **Gemini free tier and privacy.** Google may use images sent on the free tier to improve its products and have humans review them (outside the EEA/UK/Switzerland). Student names are personal data. Link a billing account to the Gemini key's Google Cloud project for the paid-tier terms (no training on your data, a scan costs a fraction of a cent). To keep everything offline set `OCR_PROVIDER=tesseract` (much less accurate on handwriting).
- **Sheets quota.** Google allows roughly 60 Sheets requests per minute for the robot account and each synced grade uses two, so a very large batch may pause and retry by itself. The ticks of a whole class are written together, so attendance uses only a few requests per save.
- **Attendance and Drive.** New attendance sheets are created in the *teacher's* Drive with the teacher's per-file (`drive.file`) permission, which cannot see anything else in their Drive. The robot has no Drive permission of its own: it only opens sheets that were shared with it (the new sheet is shared with it automatically), and the teacher can remove it from a sheet like any other editor. The teacher's Drive permission is asked on the sign-in page, lives on the phone (the same token as the sign-in), is sent to your server only with a *create the sheet* request, and is forgotten (and revoked) by **Sign out**.
- **Request limits.** The API refuses oversized or malformed requests with a plain JSON answer (413 / 400) before reading them: 1 MB for ordinary requests (`API_BODY_LIMIT`), 50 MB for a scanned picture (`OCR_BODY_LIMIT`), at most 500 grades per sync request (the app sends 100 at a time), and pictures above about 120 megapixels or 30 MB are refused. Creating attendance sheets is limited per teacher (not per shared app key), and photos sent to the reader are limited per phone and per address (`OCR_SCANS_PER_HOUR`, default 200 per phone per hour; the app sends a random installation id in `x-client-id`, which holds no personal data). Behind a proxy such as Render the server trusts the first proxy for the client address (`TRUST_PROXY`, set automatically on Render).
- **After updating the backend files** run `npm install` (or `npm ci`) once in `backend/`: four unused packages (`expo`, `sqlite3`, `uuid`, `xlsx`) were removed from `backend/package.json`, so the install is smaller and `npm audit` reports no known vulnerabilities for the backend.
- **Changing secrets** later: edit `backend/.env` (or replace `service-account.json`), stop the backend (Ctrl+C) and start it again.

## Troubleshooting

| Message in the app | Meaning |
| --- | --- |
| *Cannot reach the server* | The PC is off, the phone is on another Wi-Fi, or the firewall blocks Node.js. Check http://\<PC address\>:3000/health in the phone's browser. |
| *The server rejected the access key* | `APP_API_KEY` is set on the server but not (or differently) in the app. Remove it from `.env` for local use, or copy it into Settings → Access key. |
| *GradeScan cannot open that sheet because it is not shared with GradeScan's Google account* (the e-mail is shown) | Open the sheet in Google Sheets → Share → add that e-mail as **Editor** → try again. It is not enough that the teacher can open the sheet themselves; the robot is a separate account. |
| *Google could not find that sheet* | The link is incomplete or the sheet was deleted. Copy the whole address from the browser, including `/d/<long id>/`. |
| Notice *Share the sheet to save grades* ("You can read this sheet, but grades can only be saved into it after you share it…") | The sheet was read through "Anyone with the link can view". Share it with the robot e-mail (Editor) to be able to save grades. |
| *Saving to Google Sheets is not set up on the server yet* | The backend has no `service-account.json` (Part 2) or was not restarted after adding it. The startup log says `Google Sheets: NOT SET UP` in that case. |
| *Google does not accept the server's service account key* | The key file is damaged, was deleted in Google Cloud, or the PC's clock is wrong. Create a new key (Part 2, step 4) and replace the file. |
| Google Cloud: *Service account key creation is disabled* | Your Google Cloud project belongs to an organization (school or company) that blocks keys. Ask its administrator to allow it for this project, or create the project from a personal Google account. |
| The sign-in page says *Please tick the box…* | The agreement has to be ticked before Google or the offline option can be used. Tap the box (and read the two blue links if you like). |
| Everybody is asked to agree again | `TERMS_VERSION` in `mobile/src/legal/index.ts` was changed; that is what it is for. |
| *Google did not share your e-mail address* | The consent screen was shown without the e-mail/profile scopes. Add `openid`, `userinfo.email` and `userinfo.profile` under Data Access (Part 3), restart the backend, and sign in again. |
| *This server is not set up for Google sign-in yet* | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are missing in `backend/.env`, or the backend was not restarted. |
| Google page: *Error 400: redirect_uri_mismatch* | The address in Google Cloud must equal `GOOGLE_REDIRECT_URI` character for character (the backend log prints it). |
| Google page: *Access blocked … Error 403: access_denied* (on the sign-in page) | The consent screen is in *Testing* status and the teacher is not on the list: add their Gmail under **Audience → Test users**, or publish the app (Part 3). If it still appears for you, the consent screen may list the old `spreadsheets` scope: remove it under Data Access. |
| White page *Cannot sign in from here* after Google | The sign-in was not started from the app (or the link expired). Start again with **Continue with Google** in the app. |
| White page with **Open GradeScan**, app does not open | Tap the button again (on Android it uses an app-opening link). While developing, a second button (**Open in Expo Go** / **Open the installed app**) offers the other way back; the grey line under the buttons shows both addresses. If it still does not open, close the white page, go back to GradeScan and tap **Continue with Google** again (check that the phone and the PC are on the same Wi-Fi and that `auth-relay/callback.html` on GitHub is the current one). The link is single-use and valid for about 10 minutes. |
| *This sign-in link expired* | More than 10 minutes passed on the Google page. Try again. |
| White page *This sign-in link has expired* | You opened an old sign-in page (an old tab, or a restored one). It deliberately does nothing. Close it, go back to GradeScan and tap **Continue with Google** again. Only seen after the updated `callback.html` is on GitHub. |
| *A sign-in link from an earlier attempt came back instead of this one* (with a small trace under it) | An OLD white *Almost done* page in the phone's browser re-sent its link to the app while a new sign-in was running. The app ignores the old link, but it pulls the app to the front each time. Fix: upload the current `auth-relay/callback.html` to GitHub (Part 1), close all old white pages in the browser, and try again. The trace shows how old the link was ("N min older") and when it arrived. |
| *Cannot reach the server … No answer (timed out)*, or the button says *Opening Google…* for a few seconds before this | The phone cannot reach the backend on the PC. The server window must still be open and say `listening on port 3000`, the PC must be awake (a sleeping PC does not answer), and the phone must be on the same Wi-Fi. Quick test: open `http://<PC address>:3000/health` in the phone's browser; it must show `"status":"ok"`. If the PC's address changed (the Wi-Fi gave it a new one), restart Expo (`npx expo start -c`) so the app picks up the new address. The app waits 10 seconds for a PC on the local network (75 seconds for a hosted server that may be waking up), and **Cancel** under the button stops the attempt at any time. |
| *This sign-in link is not valid (bad-signature / malformed / missing …)* | The sign-in link that came back to the app is not the one this server issued. The word in brackets says what is wrong, and the server window prints the same reason (`[auth] sign-in link refused: …`; for *expired* it also says how long ago it ran out; hours mean an old link was delivered again). The app ignores returned links that belong to an earlier attempt, so first update the app and the server, restart both, and try once more. *bad-signature* usually means the server was restarted with a different `GOOGLE_OAUTH_CLIENT_SECRET` between tapping the button and returning. |
| *Your Google sign-in has expired* | The teacher removed GradeScan's access in their Google account. Tap Continue with Google again. |
| *GradeScan does not have your permission to create the sheet in your Google Drive. Sign out in Settings, sign in with Google again and keep the Google Drive box ticked…* | The teacher unticked the Drive line when signing in, signed in with an earlier version, took the permission back at https://myaccount.google.com/permissions, or it ran out (7 days while the app is in *Testing*). There is no allow button: **Settings → SIGN OUT**, then **Continue with Google** again with the Drive box ticked (look for `[Drive allowed]` in the backend log line `[auth] Google sign-in OK …`; `[Drive NOT allowed: …]` means Google did not grant it). Meanwhile the review screen's **SAVE THE LIST IN THE APP INSTEAD** keeps the scanned names (Excel export works). |
| Alert after signing in: *Google Drive not allowed* | On Google's page the teacher unticked the Drive line (or Google did not grant it: the backend log says `[Drive NOT allowed: …]`). They are signed in anyway. **Sign in again** in that alert asks Google once more (keep the box ticked), **Continue without Drive** keeps attendance lists in the app. |
| Result card: *GradeScan could not be added to the sheet* (with the robot's e-mail) | The sheet exists in the teacher's Drive, but Google refused to add the robot as Editor (for example a school domain that blocks sharing outside it). The teacher opens the sheet → Share → adds that e-mail as Editor; until then ticking later days fails with the usual *share the sheet* message. |
| A grade stays FAILED in the sync queue with *…not shared with GradeScan's Google account* | The sheet was not shared with the robot when the grades were saved. Share it (Editor), then tap **RETRY FAILED** in the queue. |
| *The Google Drive API is not enabled for the server's Google project* (when creating a new attendance sheet) | Part 2, step 2: enable **Google Drive API** in the same Google Cloud project as the robot, wait a minute, and try again. |
| *Your Google Drive is full, so the new sheet could not be created there* | New attendance sheets count against the **teacher's** Drive space. Free some space in Google Drive and try again (or choose *Only in the app* + Excel). |
| *Google did not allow GradeScan to create the sheet in your Drive (Google said: "…")* | Read the words in quotes: they are Google's own reason. If they mention an API *"has not been used in project … or it is disabled"*, enable it (Part 2, step 2: Google Sheets API **and** Google Drive API), wait a minute, and try again. Anything about a *policy* or *domain* usually means the teacher's school Google account blocks apps like this: they can use a personal Gmail on the Drive step (**USE ANOTHER GOOGLE ACCOUNT**), or choose **Only in the app + Excel export**. The server already tries the Drive API first and the Sheets API second. The server window prints the same reason (`createAttendanceSheet error: …`). |
| *This server is not set up for Google sign-in yet … (Part 3)* when creating a sheet | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` are missing in `backend/.env` (creating a sheet needs them now, because it acts as the teacher). |
| Attendance: *CHECK AGAIN* page (*Share the sheet first*) | The sheet is readable but not shared with the robot as **Editor**. Share it with the e-mail shown on that page, then tap CHECK AGAIN. |
| Attendance: *Column X already has the title …* | You picked **+ NEW COLUMN** with a letter that is already used under another title. Choose that column from the list, or add a different new column. |
| Attendance: the result says some ticks were *skipped* | Those cells in the tick column already contained something, so GradeScan left them as they were (nothing is overwritten). Clear them in the sheet and save again if they should become ✓. |
| Attendance: *The worksheet "…" was not found* | The tab was renamed or deleted after the class was saved. Open **I already have a sheet**, paste the link again and pick the worksheet. |
| Attendance: *The Excel file was created, but sharing is not installed* | Run `npx expo install expo-sharing` in `mobile`, then restart Expo (`npx expo start -c`). |
| *quota … free-tier limit reached* | The free Gemini quota is used up for now. |
| *Gemini did not answer — gemini-…: timed out / server error 503* | Google's free models are slow or overloaded. The server already tried each model; wait a minute and scan again. |
