# Release checklist — Brain 2.5.0

All checks must pass before deployment; record the environment and evidence for each.

- [ ] Run `npm test`, `npm run build`, and `npm run audit` in `brain/`; retain the logs.
- [ ] Run `npm audit` for dependency vulnerabilities and review any findings.
- [ ] Review the shipped assets for secrets and verify dependency licences.
- [ ] Manually check keyboard and screen-reader access, focus management, contrast and reduced motion in both themes, including at mobile and desktop sizes.
- [ ] Test PWA install and offline reload on supported browsers and devices; verify reminders and their documented browser limitations.
- [ ] Export plain and encrypted backups, restore in a clean profile, and compare records and settings.
- [ ] Test storage failure handling and confirm existing data is retained.
- [ ] Verify diagnostics version and redacted output; check Instagram with a test account and only publish after explicit confirmation.
- [ ] Verify the service-worker upgrade and rollback paths in a deployed environment.

Automated checks alone are not a certification of manual device, accessibility or integration checks. Do not release with outstanding failures.
