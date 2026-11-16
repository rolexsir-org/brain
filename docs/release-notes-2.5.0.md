# Brain 2.5.0 release notes

This release refreshes the existing offline-first PWA with a responsive workspace, desktop sidebar and mobile navigation, a real-data home dashboard, module views, and a light-first design system with dark mode. The assistant, record actions, Instagram workspace, settings, diagnostics and backup flows continue to use the existing application and local data stores.

The service worker precaches the new UI modules under the 2.5.0 cache version. No data migration or new account is required for the redesign. As always, export a backup before clearing browser data or changing devices.

## Verification and release gate

Run `npm test`, `npm run build`, and `npm run audit` from `brain/`. The automated suite covers the redesigned navigation, module views, real-data workflows, settings and sheet controls as well as existing functionality. These checks do not replace manual testing on actual browsers and devices. Before deployment, follow [the release checklist](release-checklist.md), including offline and install checks, backup and restore, accessibility review, reminders and Instagram's explicitly confirmed publish flow.

Historical documents and certification reports for earlier versions remain unchanged and are not evidence of certification for this release.
