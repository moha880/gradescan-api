# Publishing GradeScan so any teacher can use it on any network

Goal: a teacher on **any Wi-Fi or mobile data**, with your PC switched off, installs GradeScan from a link and uses it. You asked for this to be **free and without card details**, for **Android only**, shared as a **download link**, for **20 to 100 teachers**.

```
Teacher's phone (installed app, APK)
        │  https, from anywhere
        ▼
Render (free web service)  ──▶  Gemini (reads the photos)
   = the backend that is now     ──▶  Google Sheets (as GradeScan's "robot" account)
   on your PC                    ──▶  Google sign-in (the server's own /auth/google/callback page)
```

You create four free accounts yourself (I cannot create accounts for you): **GitHub** (you may have it already), **Render**, **Expo**, and you already have **Google Cloud**. Total time: about 1 hour, most of it waiting for builds.

## What is and is not free (checked on 30 October 2026)

| Piece | Cost | The catch |
|---|---|---|
| Render free web service | $0. Render's own pages say **no credit card is required**. | It **sleeps after 15 minutes** without use; the next request needs **about a minute** to wake it. 750 free hours per month per workspace (one server awake all month is 744). Nothing is stored on it between restarts (GradeScan keeps no data on the server). |
| Expo EAS Build (makes the APK) | $0 on the free plan. | Free builds are **low priority** (waiting can reach 90+ minutes at busy times) and the plan has a limited number of builds (its pricing page lists 15 Android builds). |
| Google sign-in | $0 | The consent screen must be set to **In production** (Part C) or only the 100 listed "test users" can sign in, and their permission ends after 7 days. |
| Gemini (reads the handwriting) | $0 on the free tier | Limits are per Google project and shared by **all** your teachers (the numbers are shown in Google AI Studio, not fixed here). **On the free tier Google may use the photos to improve its products** (the Gemini pricing page says "Used to improve our products: Yes" for the free tier, "No" for the paid tier). The photos contain student names. Moving to the paid tier needs a billing account, which needs a card; that is your decision. The in-app Privacy Notice already tells teachers that Google handles the photos under its own terms. |

**If Render asks you for a card:** Render's pages say it does not, but a note written earlier in `DEPLOY.md` says it did when this was first set up, and a Render support answer says it sometimes asks for "verification" (a $1 charge that is reversed). I could not create an account to find out which is true today. **If it asks, stop there and do not enter a card**; tell me and we choose another way. I checked the alternatives too: Google Cloud Run and Fly.io need a card, and Hugging Face now needs a paid plan for Docker Spaces.

## Before you start: two things to fill in

1. **`mobile/src/legal/index.ts` → `CONTACT_EMAIL`** is empty. A public app should show a real contact address in its Terms and Privacy Notice. Put yours there (the line stays hidden while it is empty).
2. **Package name.** The Android app is called `com.gradescan.app` (`mobile/app.json` → `android.package`). Any name works for a download link. Change it **now** if you want another, because it cannot change after the app is on Google Play.

## Part A: the server on Render (about 20 minutes)

**A1. Put the backend on GitHub.** Create an empty repository on github.com (for example `gradescan-api`). Then in PowerShell:

```powershell
cd "C:\Users\BT\Desktop\New folder (2)\backend"
git init
git add .
git status
```

Read the list that `git status` prints. **`.env` and `service-account.json` must NOT be in it** (the `.gitignore` already leaves them out; if either appears, stop and tell me). Then:

```powershell
git commit -m "GradeScan API"
git branch -M main
git remote add origin https://github.com/<your-github-name>/gradescan-api.git
git push -u origin main
```

**A2. Create the server.** On render.com sign up with GitHub. **New → Blueprint →** pick the repository. Render reads `render.yaml` (free plan, Frankfurt, the health check) and asks you for the secrets:

| Render asks for | Put |
|---|---|
| `GEMINI_API_KEY` | a **new** key from https://aistudio.google.com/apikey (never reuse a key you pasted in a chat) |
| `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` | from Google Cloud → your OAuth client (`DEPLOY.md`, Part 3) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the robot's key file as **one line**. In PowerShell, in the folder that holds `service-account.json`: `node -e "process.stdout.write(JSON.stringify(require('./service-account.json')))" \| clip` and paste with Ctrl+V. Do not paste it anywhere else. |

`APP_API_KEY` is made by Render itself. After the first deploy open the service → **Environment** → show `APP_API_KEY` → copy it (you need it in Part B).

**A3. Check it.** When Render says *Live*, open `https://<your-service>.onrender.com/health` in a browser. You should see `"status":"ok"` (the first call after a sleep can take a minute). Write the address down.

**A4. Tell Google the new return address.** Google Cloud → Google Auth Platform → **Clients** → your web client → **Authorized redirect URIs → Add**:

```
https://<your-service>.onrender.com/auth/google/callback
```

You do **not** need the GitHub Pages page any more for this server (Render sets its own public address by itself; leave `GOOGLE_REDIRECT_URI` empty).

## Part B: the Android app (about 30 minutes, mostly waiting)

**B1. Put the server address and key into the app.** Edit `mobile/app.json` → `extra`:

```json
"extra": {
  "backendUrl": "https://<your-service>.onrender.com",
  "apiKey": "<the APP_API_KEY you copied>"
}
```

Then every teacher gets the right server without typing anything. Be clear about what the key is: it ends up **inside the app file**, so anyone who gets the app can extract it. It keeps casual strangers out; it is not a secret. What protects your Gemini quota is the **hourly limit per phone** (below), and your sheets stay safe because the robot can only open sheets that someone shared with it.

**B2. Build.** Create a free account at expo.dev, then in PowerShell:

```powershell
npm install --global eas-cli
cd "C:\Users\BT\Desktop\New folder (2)\mobile"
eas login
eas build -p android --profile preview
```

Answer **yes** when it offers to create the project and to generate an Android keystore. EAS keeps the keystore: **keep your Expo account**, because every later update of the app must be signed with the same key. The build runs on Expo's computers; expect 10 to 30 minutes, more if the free queue is busy.

**B3. Get the app.** When it finishes, the command prints a link (and the build page on expo.dev shows a QR code). Open that link on an Android phone to download the **APK**. Also download the APK file itself from the build page and keep it: Expo keeps builds only for a limited time, and a file you hold (for example in your own Google Drive) keeps working.

## Part C: let anyone sign in

In Google Cloud → **Google Auth Platform → Audience** → **Publish app** (status *In production*). GradeScan asks only for name, e-mail and Google's per-file Drive permission (`drive.file`), which Google lists as non-sensitive, so the "unverified app" warning and its 100-user cap, which Google's help page ties to sensitive scopes, should not apply. I could not confirm this on your Google account. If Google shows the console a verification request, follow it; the **Branding** page also lets you add the app name, a support e-mail and a privacy-policy address.

## Part D: send it to the teachers

Send the link (or the APK file) by WhatsApp or e-mail. On the phone: open the link → download → Android asks to allow **installing from this source** once → install → open GradeScan → tick **I agree** → **Continue with Google**.

Tell teachers two things:

- The **first scan after a quiet period can take up to a minute** (the free server is waking up). The app waits up to two and a half minutes for the answer, and it wakes the server when the grade-scanning camera opens.
- To save grades they must **share their Google Sheet with the robot's e-mail as Editor** (the app shows the address).

## What protects the free Gemini quota

The photo reader (`POST /api/ocr`) now counts photos **per phone** (a random ID the app creates on first start; it holds no name or e-mail) and **per network address**. Defaults: **200 photos per phone per hour**, and 5 times that per address, because a whole school can sit behind one address. A phone over its limit gets *"Too many photos were sent from this phone in the last hour. Please try again in about N minutes."* Change it with `OCR_SCANS_PER_HOUR` in Render → Environment. The counters are kept in memory, so they start empty each time the free server wakes up. This limit protects against one phone using everything; it cannot stop Google's own free quota from running out when many teachers scan at once (the app then shows the quota message).

## Updating later

- **Server:** push to GitHub (`git add .`, `git commit -m "..."`, `git push`); Render redeploys by itself.
- **App:** raise `android.versionCode` in `mobile/app.json` by 1 (and `version` if you like), run `eas build -p android --profile preview` again, and send the new link. Teachers install it over the old one (same key, so their classes stay).

## Optional: keeping the server awake

A free monitor such as UptimeRobot can open `/health` every 5 minutes so the first scan of the day does not wait. It needs no card. It uses the 750 free hours (744 in a 31-day month) and I have not tested it with Render's rules, which can change; the app works without it.

## What was and was not verified

| Item | Status |
|---|---|
| Server builds with `tsc` and the built server (`node dist/index.js`) answers `/health`, locks `/api` without the key, and refuses the 3rd photo with 429 when the limit is 2 | **Verified** on a local run (not on Render) |
| Photo limit, per-phone ID, the app's "too many photos" message | **Verified by isolated tests** (backend/ocr-limit 11, mobile/client-id 6, mobile/ocr-service 5) |
| Android project generation from `app.json` (package, version code, `gradescan://` link, camera permission only) | **Verified** with `expo prebuild` in a scratch folder. The APK itself is built by Expo's servers; **not built here** |
| Render deployment, EAS build, Google "In production", installing on a phone, signing in from the installed app | **Not verified**: they need your accounts and phone |
| Render needing no card | **Not verified** (see above) |

## If something goes wrong

| What you see | Why / what to do |
|---|---|
| *No answer (timed out)* on the first try | The free server was asleep. Wait a minute and try again. |
| *The server rejected the access key* | `apiKey` in `mobile/app.json` is not the same as `APP_API_KEY` on Render (rebuild after fixing), or type it in Settings → Access key. |
| *Too many photos were sent from this phone…* | The hourly limit. Wait the number of minutes it says, or raise `OCR_SCANS_PER_HOUR`. |
| *Access blocked: … access_denied* when signing in | The consent screen is still in **Testing**; publish it (Part C). |
| *redirect_uri_mismatch* | The address in A4 is not exactly `https://<your-service>.onrender.com/auth/google/callback`. |
| Gemini quota message | The free daily quota of the Google project is used up for today; it resets at midnight Pacific time. |
| Render says *suspended* | The 750 free hours of the month are used up; it returns next month. |
