# Upcoming Fixes

- Remove all traces of DevOps etc.. from Homepage. bcoz this website is only for practicing bash online while having complete Linux environment in hand so users feel natural.. also keep website features simple like features cards section in Homepage etc.. make Landing page more aesthetic and modern 3d SAAS feel with limited text and all
- Fix saving issue: if a file has already been saved, pressing Ctrl+S should save immediately and not prompt for a file name. Only new files should ask for a file name on save. like dont open file name tab if file alredy saved!
- Fix tab close behavior: when closing a file with unsaved changes via the X icon, ask the user to save or discard changes. If discarded, keep the previous saved version unchanged.
- Remove the requirement to always have at least one file open by default. If the user closes the last file, show an empty playground state with controls for opening or creating files instead of automatically opening another Untitled.sh.
- Update file picker behavior: the Open dialog should allow opening files from the current user’s home directory (e.g. `/home/bashuser`), not only the workspace root.
- Fix modified indicator behavior: when editing non-Bash files, show a standard change marker. Bash scripts should not show the flash emoji by default.
- Remove the Clear Editor button from the UI.
- Fix Save / Save As button behavior across the IDE to match standard save semantics.
- Fix session reuse: opening the same IDE URL in another tab or browser on the same system should reuse the existing session when appropriate, rather than creating a new session and starting a separate timer.

# Future Updates

- Limit active sessions to 50 at a time. If 50 users are already online, do not spin up additional pods. Instead, show a waiting state on the home page with estimated wait time based on sessions closest to expiration.
- Verify isolation: ensure there is no way for one user to enter another user’s pod, even by mistake.
