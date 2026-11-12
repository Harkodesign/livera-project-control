# LIVERA Project Control

A project-management site for one building project: programme, tasks, files with version history, drawing register, approvals, site logs, snags, checklists, materials, contacts, and a budget that only the owner and editors can see.

It is a single web page with no build step. Vercel hosts it. Supabase holds the data, the files and the sign-in.

> **This repository is public.** It holds code only. Never commit a client name, project name, drawing, quantity or rupee figure. Project data lives in Supabase and is loaded through the site.

## What is in here

| File | What it does |
|---|---|
| `index.html` | The whole page: screens, styles and behaviour |
| `backend.js` | Sign-in, database, file storage, member list and data-pack import, on Supabase |
| `api/config.js` | Vercel function that passes the Supabase address and public key to the page |
| `supabase/schema.sql` | Tables, access rules, file bucket and live updates. Run once in Supabase |
| `dev/` | Local preview with stand-in data. Not deployed |

## Set up (about 20 minutes, no coding)

### 1. GitHub

Create an empty **public** repository named `livera-project-control` under `Harkodesign`, and push this folder to it.

### 2. Supabase

1. Create a project at supabase.com. Pick a region close to the team.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`.
3. On the **last statement**, replace `owner@example.com` with your own email. Then press **Run**.
4. Open **Project Settings → API** and copy two values: the **Project URL** and the **anon public** key.

### 3. Vercel

1. **Add New → Project**, import the GitHub repository.
2. Framework preset: **Other**. Leave the build command and output directory empty.
3. Add two environment variables:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon public key
4. Deploy. Note the address Vercel gives you, for example `https://livera-project-control.vercel.app`.

### 4. Point sign-in at the site

In Supabase, open **Authentication → URL Configuration**:

- **Site URL**: your Vercel address.
- **Redirect URLs**: add the same address.

### 5. First sign-in

1. Open the Vercel address, enter your email, and open the link that arrives. Open it **on the same device and browser** you asked from.
2. On **Overview**, press **Edit project details** and enter the project name.
3. On **People**, under **Owner only**, add each teammate with their email and a role.
4. Still on **People**, press **Import a data pack** and select `data.json` together with every file it lists. Do this once.

## Roles

| Role | Can do |
|---|---|
| Owner | Everything, plus decide who can sign in and import a data pack |
| Editor | Everything in the project, including budget and payments |
| Contributor | Add and change everything except budget, payments and project details |
| Viewer | Read only. No budget |

Budget and payments are blocked in the database itself, not just hidden on the page. A person whose email is not on the list sees "No access yet".

## Files

- Any file type, up to 50 MB each. Bigger files can be added as a link.
- Uploading a file with the same name as an existing one adds a new version. Nothing is overwritten. Any older version can be opened or made current again.
- Files are private. The site opens them through links that expire after an hour.

## Known limits

- **Supabase free plan:** about 1 GB of file storage, 50 MB per file, and the project pauses after a week with no activity (un-pause it from the Supabase dashboard). Check the current numbers on Supabase's pricing page.
- **Sign-in emails:** Supabase's built-in sender allows only a few emails per hour. A larger team needs custom SMTP (Authentication → SMTP settings).
- **No notifications.** The site sends no emails or alerts about changes.
- **Two people, one file, same moment:** if two people add a version to the same file at the same instant, one can be lost. Reload and add it again.
- **Sign-in links** work once, and only in the browser that asked for them.

## Not built (possible later)

Notifications and email digests, drag-and-drop on the programme chart, offline use, a phone app, and a link to Google Drive.

## Try it on your own computer

```bash
node dev/server.js
```

Then open http://localhost:5210. Without Supabase settings it uses stand-in data kept in your browser. Sign in as `owner@example.com`, `editor@example.com`, `contributor@example.com` or `viewer@example.com` to see each role. No email is sent.

To preview against your real Supabase project, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` before starting it, and add `http://localhost:5210` to the Redirect URLs in Supabase.

## Checks to run after the first deploy

The stand-in data copies the access rules but is not the real database. After setting up Supabase, confirm these once:

| Check | How |
|---|---|
| Budget is hidden | Sign in as a Viewer and as a Contributor: no Budget section |
| Strangers are locked out | Sign in with an email that is not on the list: "No access yet" |
| Versions | Upload a file, upload it again with the same name: v1 and v2 both open; **Make current** switches |
| Large files | A 45 MB PDF uploads; a 60 MB file is refused with a clear message |
| Live updates | Two browsers: a task moved in one appears in the other |
| No data in the repo | `git grep -i -E "<client or project name>|₹[0-9]"` finds nothing |
