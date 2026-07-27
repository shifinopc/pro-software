// Read a ?token= reset token from the URL.
// Kept OUT of App.tsx on purpose: React Fast Refresh only works when a module exports
// React components. App.tsx exporting this plain function forced a full remount every edit
// (and periodic dev-server reloads). This lives here so App.tsx stays component-only.
export const getResetToken = (): string | null => {
  try { return new URLSearchParams(window.location.search).get("token"); } catch { return null; }
};
