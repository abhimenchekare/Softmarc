# Animated PowerPoint inside the Softmarc lesson screen

This is the **simple, in-site** setup. Students do not download the presentation and do not leave the lesson page.

## What this build does

- The Admin Course Manager accepts only **PDF** and modern **PPTX** lesson documents.
- A PPTX is shown in the existing **PDF / PPT** lesson screen through one PowerPoint viewer inside Softmarc.
- There is no Google fallback button, no separate-tab link, and no download button in the lesson screen.
- Old `.ppt`, `.pps`, and `.ppsx` files are deliberately refused. Save them as `.pptx` first.
- `/pdfs/` serves only `.pdf` and `.pptx`; it cannot be used as a general public file folder.

> A browser cannot run every legacy PowerPoint feature exactly as desktop PowerPoint does. Use a current `.pptx`, embed MP4 media in it, and test one lesson in an incognito window before assigning it to learners.

---

## Part 1 — Deploy the Softmarc update

1. Upload/commit the complete release package in one push.
2. In Hostinger, press **Redeploy**.
3. Press **Restart App**.
4. Open `admin.html` and a lesson page, then press **Ctrl+F5**.
5. Sign in again once.

Do not upload only `lesson.html`: the viewer, upload guard, Course Manager and both server files must be deployed together.

---

## Part 2 — One-time Hostinger safety rule

Keep Bot Protection enabled for the rest of the website.

1. In hPanel open **Websites → Manage → Security → Bot Protection**.
2. Look for an **exception**, **allow rule**, **bypass rule**, or **path rule**.
3. Add only this path:

   ```text
   /pdfs/*
   ```

4. Save the rule.
5. Do **not** disable protection for `/api/*`, `/admin.html`, login, or the whole site.

If your hPanel has no path-specific rule, ask Hostinger support to make this narrow exception. Send them this exact request:

> Please keep Bot Protection enabled for softmarcedu.in, but allow Microsoft PowerPoint Online to fetch public static lesson documents at `https://softmarcedu.in/pdfs/*.pptx`. Do not exempt `/api/*`, admin pages, login pages, or the full domain.

This does not expose the database or Admin panel. It only allows the public lesson PPTX files to be fetched by the viewer.

---

## Part 3 — Add an animated presentation

1. Open the PowerPoint in desktop Microsoft PowerPoint.
2. Choose **File → Save As** and save it as **PowerPoint Presentation (`.pptx`)**.
3. For embedded video, use MP4 where possible, then choose **File → Info → Optimize Media Compatibility**.
4. In Softmarc go to **Admin → Course Manager → Videos, PDF & Exercises**.
5. Select the correct **Main topic** and **Subtopic**.
6. Under **PDF / PPTX**, upload the `.pptx` file.
7. Keep the page open until the green message confirms that the file was saved and is reachable.
8. Open that lesson in an incognito window and press **PDF / PPT** to test it exactly as a student would.

The admin panel rejects `.ppt` files on purpose. Convert/re-save those files as `.pptx` first.

---

## Safety boundaries

- Only an authenticated admin can upload/attach a lesson file.
- Public lesson links are readable by anyone who has the URL, so never put passwords, student marks, personal data, or secrets inside a PDF/PPTX.
- File names are randomised by the server, and the public document path only serves `.pdf` and `.pptx` files.
- Keep a strong Admin password and enable two-factor authentication on the Hostinger account.
