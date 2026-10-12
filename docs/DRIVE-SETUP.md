# Setting up Google Drive

Google Drive is optional. Everything in the app works without it. To import from Drive and export to it, you create one Google Cloud OAuth client (about ten minutes, once), then paste its ID and secret into the app.

Checked against Google's documentation on 2026-10-11: "Configure the OAuth consent screen", "Create access credentials", "OAuth 2.0 for iOS & Desktop Apps", and "Choose Google Drive API scopes". Google renames console menus from time to time; if a label below differs, the step is still the same.

## 1. Create a project (or use the one that exists)

If the project picker already lists **Novel Companion** (project ID `novel-companion-511219`), select it and go on to step 2. Otherwise create it:

1. Go to https://console.cloud.google.com and sign in as **tommythemadden@gmail.com**.
2. In the project picker at the top left, click it, then **New project**.
3. Project name: `Novel Companion`. Leave Location as is. Click **Create**.
4. When it finishes, make sure the project picker shows **Novel Companion**.

## 2. Turn on the Google Drive API

1. Menu (three lines, top left) > **APIs & Services** > **Library**.
2. Search for `Google Drive API`, open it, click **Enable**.

That is the only API needed. The app does not use the Google Picker API or the Docs or Sheets APIs: Google Docs and Sheets are exported through the Drive API.

## 3. Configure the consent screen (Google Auth platform)

1. Menu > **Google Auth platform** > **Branding**. If it says "Google Auth platform not configured yet", click **Get Started**.
2. **App Information**: App name `Novel Companion`; User support email `tommythemadden@gmail.com`. Click **Next**.
3. **Audience**: choose **External**. Click **Next**.
4. **Contact Information**: `tommythemadden@gmail.com`. Click **Next**.
5. **Finish**: tick "I agree to the Google API Services: User Data Policy", click **Continue**, then **Create**.
6. Click **Audience** in the left menu. Publishing status should read **Testing**. Under **Test users**, click **Add users**, enter `tommythemadden@gmail.com`, click **Save**.
7. Click **Data Access** > **Add or Remove Scopes**. Tick these two (filter for "drive"):
   - `.../auth/drive.readonly` (See and download all your Google Drive files)
   - `.../auth/drive.file` (See, edit, create, and delete only the specific Google Drive files you use with this app)

   Click **Update**, then **Save**. (Listing scopes here is for the consent screen's records; the app asks for them itself when it signs in.)

You do not submit the app for verification. In Testing, only the test users you list can sign in, which is exactly you.

## 4. Create the OAuth client (Desktop app)

1. Menu > **Google Auth platform** > **Clients** > **Create Client**.
2. Application type: **Desktop app**. Name: `Novel Companion on my Mac`. Click **Create**.
3. A dialog shows the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`). Copy both now, or click **Download JSON** and keep the file somewhere private. Google may not show the secret again; if you lose it, open the client and use **Add secret** to make a new one.

Do not put the ID or secret in the repository, an email, or a note in the app. The app keeps them in the macOS keychain.

## 5. Enter the client in the app

1. Open the app and a bible, then click **Settings** in the rail (under Manage). The Google Drive panel says "Not set up".
2. Paste the **OAuth client ID** and **OAuth client secret**, click **Save the client**. The panel now says "Not connected." and shows the client ID with its middle hidden.
3. Click **Connect Google Drive**. Your browser opens Google's sign-in page.
4. Choose `tommythemadden@gmail.com`. Google shows "Google hasn't verified this app": click **Continue** (this is your own app in Testing).
5. Google lists what the app asks for: **See and download all your Google Drive files**. Leave it ticked and click **Continue**.
6. The browser says "Google Drive is connected. You can close this tab." Back in the app, the panel says "Connected as tommythemadden@gmail.com".

The keychain items are in Keychain Access under the name `novel-companion-google` (accounts `oauth-client` and `oauth-tokens`).

## 6. Exporting: one more permission

Export is a separate, explicit action. The first time, **Google Drive** > **Export to Drive** shows **Allow export**. Click it; the browser lists both permissions: **See and download all your Google Drive files** (the import permission, asked again together with the new one) and **See, edit, create, and delete only the specific Google Drive files you use with this app**. Keep both ticked and click **Continue**. If either is unticked, the app says so and export stays off.

With that access the app can write only into folders it created itself. Click **Make the folder** to create an export folder (it appears at the top of My Drive). You may move that folder anywhere in Drive afterwards; exports keep going to it. Each export makes a new dated folder inside it, so nothing earlier is overwritten.

## Things to know

- **Weekly reconnect.** While the Google Cloud app is in Testing, Google ends the sign-in after 7 days. The app then says "Google ended the Drive connection" and you click **Connect Google Drive** again. To stop this, go to **Google Auth platform** > **Audience** and click **Publish app**. Because the app asks for a restricted scope (`drive.readonly`) and is not verified, Google keeps showing the "hasn't verified this app" screen and limits it to 100 users, which is fine for one person.
- **Disconnect** (Settings) deletes the tokens from the keychain and asks Google to revoke them. Links to files stay, so reconnecting picks up where you left off. **Remove the client** also deletes the client ID and secret.
- To remove the app's access from the Google side as well: https://myaccount.google.com/permissions.
- Google exports a Google Doc or Sheet up to 10 MB. A larger file has to be downloaded as Word or Excel and imported from disk.

## Manual check of the real flow (run once after setup)

Record the date and result in `PROGRESS.md` under M9.

1. [ ] Settings shows "Not set up" before step 5, and "Not connected." after saving the client.
2. [ ] Keychain Access shows `novel-companion-google` / `oauth-client`; no file under `~/Library/Application Support/Novel Companion` contains `GOCSPX-`.
3. [ ] Connect opens the system browser (not a window inside the app); Google's consent lists only "See and download all your Google Drive files".
4. [ ] After allowing, the panel shows "Connected as tommythemadden@gmail.com".
5. [ ] Google Drive > Add files or folders: My Drive lists your folders; Shared with me and Search work; a PDF has no checkbox.
6. [ ] Link the East Winds folder (or the "East Winds" Google Doc and the World workbook). Check for changes lists each as "Not imported yet".
7. [ ] Import the World workbook (a Google Sheet or .xlsx): the saved mapping from the local import is offered; Compare shows "unchanged" for rows imported before from the same file name.
8. [ ] Import a Google Doc as a general note: italics and scene breaks survive.
9. [ ] Edit that Google Doc in Drive, quit and relaunch: the launch notice says one linked file changed. Review changes shows the comparison; nothing changes until Apply.
10. [ ] Export to Drive > Allow export: the browser lists both "See and download all your Google Drive files" and "the specific Google Drive files you use with this app", and both are ticked. Make the folder, Export the whole bible: Drive shows a dated folder with a JSON file and one folder per section of Markdown files.
11. [ ] Load that JSON into an empty bible (Backups > Load an exported bible into a new bible): counts match.
12. [ ] Disconnect: the panel says "Not connected."; Keychain Access no longer has `oauth-tokens`; myaccount.google.com/permissions no longer lists Novel Companion (revoked). The app still opens, edits, and imports local files.
